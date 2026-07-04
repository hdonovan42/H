#!/usr/bin/env python3
"""Train WaymoNet on REAL data (1-class: waymo) — run on a rented GPU after preflight.py.

Model: YOLO26s + P2 (stride-4) head, COCO-pretrained transfer. YOLO26 = latest generation
(NMS-free end-to-end, better small-object behaviour); the P2 head keeps the high-res feature
map a 5-15px dome needs. Verified to build + accept yolo26s.pt transfer on CPU.

Efficiency (vs the old synthetic-era recipe):
- imgsz 704, not 1280: source frames are 352x288 — 1280 trained mostly on interpolation at
  ~3x the compute. 704 (2x) + P2 gives the same effective resolution on the dome.
- cache='ram': the whole dataset is a few thousand ~25KB jpegs; without it the GPU idles
  behind CPU jpeg decode every epoch.
- batch=-1: auto-fit the 24GB card instead of hardcoding 16.
- mosaic 0.4 / scale 0.15: mosaic halves object scale — at 1.0 it routinely pushed the dome
  below the measured ~44px-host resolvability floor (training on boxes whose feature is
  invisible = label noise). Toned down, closed for the last --close-mosaic epochs.

RUN_3+ defaults (locked 2026-07-02, see GPU_RENT_NOTES "Run 3 — plan"): epochs 100 +
close_mosaic 20 — RUN_2 (150/15) early-stopped at e127, BEFORE the 135-150 close window, so the
mosaic-off finishing phase never ran; at 100/20 the window (80-100) is reachable and cos_lr
completes. workers 16 (RUN_2's 8 left the GPU dataloader-starved at 58%). WARM-START is the
standing recipe: pass the previous run's weights as --model (a .pt fine-tunes directly, no COCO
transfer); fresh-from-COCO (the yaml default) is the poisoned-lineage exception only.

Dataset: data/dataset_real (build_real_dataset.py — confirms + vetted rejects from waymo.db).
"""
import argparse
import os

from ultralytics import YOLO

BASE = __file__.rsplit("/train/", 1)[0]


def portable_data_path(data_yaml):
    """build_real_dataset.py bakes an ABSOLUTE `path:` (the build box) into dataset.yaml, which is
    wrong the moment the dataset is rsync'd to a GPU box (Vast run 2026-06-20 crashed on the VPS
    path). Repoint `path:` at the yaml's own directory so training works wherever the dataset
    actually lives — no manual sed. Idempotent."""
    dy = os.path.abspath(data_yaml)
    ddir = os.path.dirname(dy)
    lines = open(dy).read().splitlines()
    if not any(ln.strip() == f"path: {ddir}" for ln in lines):
        lines = [f"path: {ddir}" if ln.split(":", 1)[0].strip() == "path" else ln for ln in lines]
        open(dy, "w").write("\n".join(lines) + "\n")
        print(f"dataset.yaml path -> {ddir} (portability fix)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="yolo26s-p2.yaml",
                    help="model cfg (yolo26s-p2.yaml) or weights (.pt) to fine-tune directly")
    ap.add_argument("--weights", default="yolo26s.pt",
                    help="pretrained weights transferred into the cfg graph")
    ap.add_argument("--data", default=f"{BASE}/data/dataset_real/dataset.yaml")
    ap.add_argument("--imgsz", type=int, default=704)
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--close-mosaic", type=int, default=20,
                    help="mosaic OFF for the last N epochs (window must be reachable pre-early-stop)")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--lr0", type=float, default=0.0,
                    help="initial LR override (0 = optimizer default; ~0.005 is gentler for warm-start)")
    ap.add_argument("--batch", type=int, default=-1, help="-1 = auto-fit VRAM")
    ap.add_argument("--device", default="0")
    ap.add_argument("--name", default="waymonet_real_v1")
    ap.add_argument("--no-export", action="store_true")
    a = ap.parse_args()

    portable_data_path(a.data)
    m = YOLO(a.model)
    if a.model.endswith(".yaml") and a.weights:
        m.load(a.weights)
    extra = {"lr0": a.lr0} if a.lr0 else {}
    results = m.train(
        data=a.data, imgsz=a.imgsz, epochs=a.epochs, batch=a.batch, device=a.device,
        workers=a.workers, optimizer="auto", cos_lr=True, patience=30,
        close_mosaic=a.close_mosaic, cache="ram", seed=0,
        # domain-matched, small-object-safe augmentation
        hsv_h=0.015, hsv_s=0.7, hsv_v=0.4,
        degrees=3.0, translate=0.05, scale=0.15, shear=2.0, perspective=0.0005,
        fliplr=0.5, flipud=0.0, mosaic=0.4, mixup=0.0, copy_paste=0.0,
        project=f"{BASE}/data/runs", name=a.name, exist_ok=True, plots=True, **extra,
    )
    print("val mAP50:", round(float(results.box.map50), 4),
          "| mAP50-95:", round(float(results.box.map), 4))
    print("NOTE: run train/eval_gate.py next — mAP is not the ship decision; the gate is.")
    if not a.no_export:
        path = m.export(format="onnx", imgsz=a.imgsz, simplify=True, dynamic=False)
        print(f"exported ONNX @ {a.imgsz} -> {path}")
        print("(re-export at the serving resolution once Phase-5 inference settles on one)")


if __name__ == "__main__":
    main()
