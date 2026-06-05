#!/usr/bin/env python3
"""Post-train acceptance gate: does WaymoNet distinguish Waymo from Wayve at >=90%?

Builds a held-out test from cameras the model never trained on:
  - WAYMO test  = the val-split synthetic dome positives (recall)
  - WAYVE test  = curated Wayve roof-RACK crops pasted onto the SAME held-out backplates
                  via the identical pipeline (so domain matches) -> measures false positives
At the operating confidence, reports Waymo recall, Wayve false-positive rate, and the
balanced discrimination score. >=90% balanced => gate PASS (Wayve can graduate to a class).

Run AFTER training, on the GPU box (or CPU): python eval_wayve_gate.py --weights <best.pt>
"""
import argparse
import glob
import json
import os
import random
import sys

import cv2
import numpy as np

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "dataset"))
from copy_paste import composite, feathered_alpha, jamcam_degrade  # noqa: E402

RACKS = sorted(glob.glob(os.path.join(BASE, "data/sources/wayve_rack/*.jpg")))


def rack_alpha(r):
    h, w = r.shape[:2]
    return feathered_alpha(h, w, feather=0.18)


def build_wayve_tests(val_imgs, n=80, seed=11):
    """Paste Wayve racks onto held-out val backplate frames (the source frames of val positives)."""
    random.seed(seed)
    from ultralytics import YOLO
    det = YOLO("yolo11n.pt")
    racks = [(cv2.imread(f), None) for f in RACKS]
    out_dir = os.path.join(BASE, "data/dataset/wayve_test")
    os.makedirs(out_dir, exist_ok=True)
    for f in glob.glob(os.path.join(out_dir, "*.jpg")):
        os.remove(f)
    made = 0
    for fp in val_imgs:
        if made >= n:
            break
        img = cv2.imread(fp)
        if img is None:
            continue
        r = det.predict(img, conf=0.3, verbose=False, imgsz=352)[0]
        cars = [tuple(map(int, b.xyxy[0].tolist())) for b in r.boxes
                if int(b.cls[0]) == 2 and (b.xyxy[0][3] - b.xyxy[0][1]) >= 30]
        if not cars:
            continue
        x1, y1, x2, y2 = max(cars, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
        rack, _ = random.choice(racks)
        scale = max(8, int((x2 - x1) * 0.5)) / rack.shape[1]
        cx, cy = x1 + (x2 - x1) * 0.5, y1 + rack.shape[0] * scale * 0.4
        out, _ = composite(img, rack, cx, cy, scale, alpha=rack_alpha(rack))
        out = jamcam_degrade(out, jpeg_q=random.randint(32, 46))
        cv2.imwrite(os.path.join(out_dir, f"wayve_{made:03d}.jpg"), out)
        made += 1
    return out_dir, made


def detect_rate(model, imgs, conf):
    from ultralytics import YOLO  # noqa
    hits = 0
    for fp in imgs:
        r = model.predict(fp, conf=conf, verbose=False, imgsz=1280)[0]
        if len(r.boxes):
            hits += 1
    return hits / max(1, len(imgs))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True)
    ap.add_argument("--conf", type=float, default=0.25)
    a = ap.parse_args()
    from ultralytics import YOLO
    model = YOLO(a.weights)

    waymo_val = sorted(glob.glob(os.path.join(BASE, "data/dataset/images/val/syn_*.jpg")))
    # held-out backplates = source frames of the val positives (same unseen cameras)
    man = {m["name"]: m for m in json.load(open(os.path.join(BASE, "data/synthetic/manifest.json")))}
    val_names = [os.path.basename(f)[:-4] for f in waymo_val]
    val_backplates = [os.path.join(BASE, man[n]["source_frame"]) for n in val_names if n in man]
    wayve_dir, n_wayve = build_wayve_tests(val_backplates)
    wayve_imgs = sorted(glob.glob(os.path.join(wayve_dir, "*.jpg")))

    print(f"weights: {a.weights} | conf: {a.conf}")
    print(f"WAYMO test (val domes): {len(waymo_val)} | WAYVE test (rack composites): {len(wayve_imgs)}")
    recall = detect_rate(model, waymo_val, a.conf)
    wayve_fp = detect_rate(model, wayve_imgs, a.conf)
    bal = 0.5 * (recall + (1 - wayve_fp))
    print(f"  Waymo recall (fires on Waymo):     {recall*100:.1f}%")
    print(f"  Wayve false-positive (fires on Wayve): {wayve_fp*100:.1f}%")
    print(f"  balanced discrimination:           {bal*100:.1f}%")
    print(f"GATE: {'PASS (>=90%) — Wayve cleanly separable' if bal >= 0.90 else 'BELOW 90% — keep Wayve as hard-neg + human gate; restrict to near-field'}")


if __name__ == "__main__":
    main()
