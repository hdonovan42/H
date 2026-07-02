#!/usr/bin/env python3
"""Real-data acceptance gate for WaymoNet — the ship decision, run after train.py.

Evaluates ONLY on the held-out val cameras of data/dataset_real (PINNED via
train/val_cams_run2.txt since RUN_3, so gate numbers are comparable across runs):
  RECALL    BOX-level on val positives (every GT box counts — pre-RUN_3 this script read only
            the FIRST box per frame, under-evaluating multi-Waymo frames), with IoU >= 0.3
            matching (a stray detection elsewhere in the frame does NOT count)
  FP RATE   on val backgrounds (human-vetted reject frames) AND unmatched detections on the
            POSITIVE frames (pre-RUN_3 a spurious box on a positive image was never counted,
            making precision optimistic)
  NIGHT CUT box-recall split night vs day (from the builder's val_meta.csv, if present) —
            informational; no night stratification exists anywhere else in the pipeline.

Sweeps confidence and prints the operating table; ship bar = precision >= 0.9 at usable
recall. NB metrics are the FIXED (2026-07-02) definitions — not directly comparable to the
RUN_1/RUN_2 tables in GPU_RENT_NOTES computed with the old first-box/neg-only script; re-run
this script with the old weights on the same dataset for an honest baseline.
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


def load_labels(img_path):
    """ALL GT boxes for an image in pixel xyxy (or None for a background frame)."""
    lp = img_path.replace(os.sep + "images" + os.sep, os.sep + "labels" + os.sep)[:-4] + ".txt"
    if not os.path.exists(lp):
        return None
    im = cv2.imread(img_path)
    h, w = im.shape[:2]
    boxes = []
    for ln in open(lp).read().splitlines():
        p = ln.split()
        if len(p) >= 5:
            cx, cy, bw, bh = [float(v) for v in p[1:5]]
            boxes.append(((cx - bw / 2) * w, (cy - bh / 2) * h,
                          (cx + bw / 2) * w, (cy + bh / 2) * h))
    return boxes or None


def is_night(at):
    """captured_at is UTC ISO. London night ~= 20:00-04:59 UTC (≈21:00-05:59 BST)."""
    try:
        return int(at[11:13]) >= 20 or int(at[11:13]) < 5
    except (ValueError, IndexError, TypeError):
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True)
    ap.add_argument("--imgsz", type=int, default=704)
    ap.add_argument("--data", default=DATA, help="dataset dir (for bench hw variants)")
    a = ap.parse_args()
    from ultralytics import YOLO
    model = YOLO(a.weights)

    val = sorted(glob.glob(os.path.join(a.data, "images", "val", "*.jpg")))
    pos, neg = [], []
    for f in val:
        boxes = load_labels(f)
        if boxes:
            pos.append((f, boxes))
        else:
            neg.append(f)
    if not pos or not neg:
        raise SystemExit(f"val split incomplete (pos={len(pos)}, neg={len(neg)}) — "
                         "rebuild with build_real_dataset.py")
    total_boxes = sum(len(b) for _, b in pos)
    print(f"weights: {a.weights} | val: {len(pos)} positive frames ({total_boxes} boxes), "
          f"{len(neg)} backgrounds (held-out cameras only)")

    meta = {}
    mp = os.path.join(a.data, "val_meta.csv")
    if os.path.exists(mp):
        for ln in open(mp).read().splitlines()[1:]:
            parts = ln.split(",")
            if len(parts) >= 3:
                meta[parts[0]] = parts[2]

    # one low-conf pass per image; sweep thresholds offline
    pos_dets, neg_dets = [], []
    for f, gts in pos:
        r = model.predict(f, conf=0.05, verbose=False, imgsz=a.imgsz)[0]
        pos_dets.append((f, gts, [(float(b.conf[0]), tuple(b.xyxy[0].tolist())) for b in r.boxes]))
    for f in neg:
        r = model.predict(f, conf=0.05, verbose=False, imgsz=a.imgsz)[0]
        neg_dets.append([float(b.conf[0]) for b in r.boxes])

    print(f"{'conf':>5} {'box-rec':>8} {'img-rec':>8} {'FP-neg':>8} {'FP-pos':>7} {'precision':>10}")
    best = None
    for c in [round(0.05 * i, 2) for i in range(2, 19)]:
        mb = sum(1 for _, gts, dets in pos_dets for gt in gts
                 if any(cf >= c and iou(gt, bb) >= IOU_MATCH for cf, bb in dets))
        tp_imgs = sum(1 for _, gts, dets in pos_dets
                      if any(cf >= c and iou(gt, bb) >= IOU_MATCH for gt in gts for cf, bb in dets))
        fp_neg = sum(1 for confs in neg_dets if any(cf >= c for cf in confs))
        fp_pos = sum(1 for _, gts, dets in pos_dets
                     if any(cf >= c and all(iou(gt, bb) < IOU_MATCH for gt in gts)
                            for cf, bb in dets))
        box_rec = mb / total_boxes
        prec = tp_imgs / max(1, tp_imgs + fp_neg + fp_pos)
        print(f"{c:>5} {box_rec * 100:>7.1f}% {tp_imgs / len(pos_dets) * 100:>7.1f}% "
              f"{fp_neg:>4}/{len(neg_dets):<3} {fp_pos:>3}/{len(pos_dets):<3} {prec * 100:>9.1f}%")
        if prec >= 0.9 and (best is None or box_rec > best[1]):
            best = (c, box_rec, prec)

    if meta:
        for label, want in (("night", True), ("day", False)):
            sub = [(gts, dets) for f, gts, dets in pos_dets
                   if is_night(meta.get(os.path.basename(f), "")) == want]
            nb = sum(len(g) for g, _ in sub)
            if not nb:
                print(f"night-cut: no {label} val positives")
                continue
            for c in (0.10, 0.20):
                m = sum(1 for gts, dets in sub for gt in gts
                        if any(cf >= c and iou(gt, bb) >= IOU_MATCH for cf, bb in dets))
                print(f"night-cut: {label:>5} box-recall @{c:.2f} = {m}/{nb} ({m / nb * 100:.1f}%)")

    if best:
        print(f"GATE: PASS — operate alerts at conf={best[0]} "
              f"(box-recall {best[1]*100:.0f}%, precision {best[2]*100:.0f}%)")
    else:
        print("GATE: no conf reaches precision >= 0.9 — keep the human queue as the gate "
              "and collect more confirms before shipping autonomous alerts")


if __name__ == "__main__":
    main()
