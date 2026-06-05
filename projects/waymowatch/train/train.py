#!/usr/bin/env python3
"""Train WaymoNet (1-class: waymo dome) — run on a rented GPU.

Recipe tuned for a tiny (~10-30px) roof dome on low-res elevated traffic cams:
- YOLO11s, imgsz=1280 (super-samples the 352x288 frames so the dome's features survive)
- conservative geometric aug (high translate/scale/perspective destroy small objects)
- mosaic on, closed for the last 10 epochs for clean boxes
- copy_paste OFF (our positives are already copy-paste composites; Ultralytics copy_paste
  needs seg masks we don't have)

~1-2 h on one RTX 4090 (~$1). See RUNBOOK.md.
"""
import argparse
from ultralytics import YOLO

BASE = __file__.rsplit("/train/", 1)[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="yolo11s.pt", help="yolo11s.pt (or a P2 cfg yaml)")
    ap.add_argument("--data", default=f"{BASE}/data/dataset/dataset.yaml")
    ap.add_argument("--imgsz", type=int, default=1280)
    ap.add_argument("--epochs", type=int, default=120)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--device", default="0")
    ap.add_argument("--name", default="waymonet_v1")
    ap.add_argument("--no-export", action="store_true")
    a = ap.parse_args()

    m = YOLO(a.model)
    m.train(
        data=a.data, imgsz=a.imgsz, epochs=a.epochs, batch=a.batch, device=a.device,
        optimizer="auto", cos_lr=True, patience=30, close_mosaic=10,
        # domain-matched, small-object-safe augmentation
        hsv_h=0.015, hsv_s=0.7, hsv_v=0.4,
        degrees=3.0, translate=0.05, scale=0.3, shear=2.0, perspective=0.0005,
        fliplr=0.5, flipud=0.0, mosaic=1.0, mixup=0.05, copy_paste=0.0,
        project=f"{BASE}/data/runs", name=a.name, exist_ok=True, plots=True,
    )
    # validate (mAP on the held-out feeds) — printed by Ultralytics
    metrics = m.val(data=a.data, imgsz=a.imgsz, device=a.device)
    print("val mAP50:", round(float(metrics.box.map50), 4),
          "| mAP50-95:", round(float(metrics.box.map), 4))
    if not a.no_export:
        path = m.export(format="onnx", opset=12, imgsz=a.imgsz, simplify=True, dynamic=False)
        print("exported ONNX ->", path)


if __name__ == "__main__":
    main()
