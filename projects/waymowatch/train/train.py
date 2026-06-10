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
  invisible = label noise). Toned down, closed for the last 15 epochs.

Dataset: data/dataset_real (build_real_dataset.py — confirms + vetted rejects from waymo.db).
"""
import argparse

from ultralytics import YOLO

BASE = __file__.rsplit("/train/", 1)[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="yolo26s-p2.yaml",
                    help="model cfg (yolo26s-p2.yaml) or weights (.pt) to fine-tune directly")
    ap.add_argument("--weights", default="yolo26s.pt",
                    help="pretrained weights transferred into the cfg graph")
    ap.add_argument("--data", default=f"{BASE}/data/dataset_real/dataset.yaml")
    ap.add_argument("--imgsz", type=int, default=704)
    ap.add_argument("--epochs", type=int, default=150)
    ap.add_argument("--batch", type=int, default=-1, help="-1 = auto-fit VRAM")
    ap.add_argument("--device", default="0")
    ap.add_argument("--name", default="waymonet_real_v1")
    ap.add_argument("--no-export", action="store_true")
    a = ap.parse_args()

    m = YOLO(a.model)
    if a.model.endswith(".yaml") and a.weights:
        m.load(a.weights)
    results = m.train(
        data=a.data, imgsz=a.imgsz, epochs=a.epochs, batch=a.batch, device=a.device,
        optimizer="auto", cos_lr=True, patience=30, close_mosaic=15, cache="ram", seed=0,
        # domain-matched, small-object-safe augmentation
        hsv_h=0.015, hsv_s=0.7, hsv_v=0.4,
        degrees=3.0, translate=0.05, scale=0.15, shear=2.0, perspective=0.0005,
        fliplr=0.5, flipud=0.0, mosaic=0.4, mixup=0.0, copy_paste=0.0,
        project=f"{BASE}/data/runs", name=a.name, exist_ok=True, plots=True,
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
