#!/usr/bin/env python3
"""CPU pre-flight for the GPU training run — catch every crash for free, BEFORE renting.

Validates, on this machine, everything train.py will do on the paid box:
  1. dataset_real exists, yaml parses, every label parses with bbox in [0,1]
  2. val split has positives AND backgrounds (eval_gate.py needs both)
  3. the model cfg builds and the pretrained weights transfer into it
  4. one real forward pass at the training imgsz
Exit code 0 = safe to rent.
"""
import glob
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, "data", "dataset_real")
MODEL, WEIGHTS, IMGSZ = "yolo26s-p2.yaml", "yolo26s.pt", 704
fail = 0


def check(ok, msg):
    global fail
    print(("  ok  " if ok else "  FAIL") + " " + msg)
    fail += 0 if ok else 1


yaml_path = os.path.join(DATA, "dataset.yaml")
check(os.path.exists(yaml_path), f"dataset.yaml exists ({yaml_path})")
for split in ("train", "val"):
    imgs = glob.glob(os.path.join(DATA, "images", split, "*.jpg"))
    lbls = glob.glob(os.path.join(DATA, "labels", split, "*.txt"))
    bad = 0
    for lp in lbls:
        try:
            vals = [float(v) for line in open(lp) for v in line.split()]
            ok = len(vals) % 5 == 0 and all(0 <= v <= 1 for i, v in enumerate(vals) if i % 5)
            bad += 0 if ok else 1
        except Exception:
            bad += 1
    check(len(imgs) > 0, f"{split}: {len(imgs)} images, {len(lbls)} labels")
    check(bad == 0, f"{split}: all labels parse with coords in [0,1] ({bad} bad)")
val_imgs = glob.glob(os.path.join(DATA, "images", "val", "*.jpg"))
val_lbls = {os.path.basename(f)[:-4] for f in glob.glob(os.path.join(DATA, "labels", "val", "*.txt"))}
n_pos = sum(1 for f in val_imgs if os.path.basename(f)[:-4] in val_lbls)
check(n_pos > 0 and n_pos < len(val_imgs),
      f"val has positives ({n_pos}) and backgrounds ({len(val_imgs) - n_pos})")

try:
    from ultralytics import YOLO
    import numpy as np
    m = YOLO(MODEL)
    m.load(WEIGHTS)
    check(True, f"{MODEL} builds + {WEIGHTS} transfers")
    m.predict(np.zeros((288, 352, 3), dtype=np.uint8), imgsz=IMGSZ, verbose=False)
    check(True, f"forward pass @ imgsz={IMGSZ}")
except Exception as e:
    check(False, f"model build/forward: {e}")

print(("PREFLIGHT PASS — safe to rent the GPU" if fail == 0
       else f"PREFLIGHT FAIL ({fail}) — fix before renting"))
sys.exit(1 if fail else 0)
