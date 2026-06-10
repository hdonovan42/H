#!/usr/bin/env python3
"""Real-data acceptance gate for WaymoNet — the ship decision, run after train.py.

Evaluates ONLY on the held-out val cameras of data/dataset_real:
  RECALL    on val positives, with proper box matching (IoU >= 0.3 against the labelled
            host bbox — a stray detection elsewhere in the frame does NOT count, which the
            old gate got wrong)
  FP RATE   on val backgrounds — human-vetted reject frames + implicit negatives from
            cameras the model never trained on (any real Wayves the user rejected are in
            here, so Wayve discrimination is tested with REAL data, not rack composites)

Sweeps confidence and prints the operating table; ship bar = precision >= 0.9 at usable
recall (alerts run at the chosen conf; everything below still flows to the human queue).
"""
import argparse
import glob
import os

import cv2

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, "data", "dataset_real")
IOU_MATCH = 0.3


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def load_label(img_path):
    lp = img_path.replace(os.sep + "images" + os.sep, os.sep + "labels" + os.sep)[:-4] + ".txt"
    if not os.path.exists(lp):
        return None
    im = cv2.imread(img_path)
    h, w = im.shape[:2]
    cx, cy, bw, bh = [float(v) for v in open(lp).read().split()[1:5]]
    return ((cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True)
    ap.add_argument("--imgsz", type=int, default=704)
    a = ap.parse_args()
    from ultralytics import YOLO
    model = YOLO(a.weights)

    val = sorted(glob.glob(os.path.join(DATA, "images", "val", "*.jpg")))
    pos = [(f, load_label(f)) for f in val if load_label(f)]
    neg = [f for f in val if not load_label(f)]
    if not pos or not neg:
        raise SystemExit(f"val split incomplete (pos={len(pos)}, neg={len(neg)}) — "
                         "rebuild with build_real_dataset.py")
    print(f"weights: {a.weights} | val: {len(pos)} positives, {len(neg)} backgrounds "
          f"(held-out cameras only)")

    # one low-conf pass per image; sweep thresholds offline
    pos_dets, neg_dets = [], []
    for f, gt in pos:
        r = model.predict(f, conf=0.05, verbose=False, imgsz=a.imgsz)[0]
        pos_dets.append((gt, [(float(b.conf[0]), tuple(b.xyxy[0].tolist())) for b in r.boxes]))
    for f in neg:
        r = model.predict(f, conf=0.05, verbose=False, imgsz=a.imgsz)[0]
        neg_dets.append([float(b.conf[0]) for b in r.boxes])

    print(f"{'conf':>5} {'recall':>7} {'FP-imgs':>8} {'precision':>10}")
    best = None
    for c in [round(0.05 * i, 2) for i in range(2, 19)]:
        tp = sum(1 for gt, dets in pos_dets
                 if any(cf >= c and iou(gt, bb) >= IOU_MATCH for cf, bb in dets))
        fp_imgs = sum(1 for confs in neg_dets if any(cf >= c for cf in confs))
        rec = tp / len(pos_dets)
        prec = tp / max(1, tp + fp_imgs)
        print(f"{c:>5} {rec * 100:>6.1f}% {fp_imgs:>4}/{len(neg_dets):<3} {prec * 100:>9.1f}%")
        if prec >= 0.9 and (best is None or rec > best[1]):
            best = (c, rec, prec)
    if best:
        print(f"GATE: PASS — operate alerts at conf={best[0]} "
              f"(recall {best[1]*100:.0f}%, precision {best[2]*100:.0f}%)")
    else:
        print("GATE: no conf reaches precision >= 0.9 — keep the human queue as the gate "
              "and collect more confirms before shipping autonomous alerts")


if __name__ == "__main__":
    main()
