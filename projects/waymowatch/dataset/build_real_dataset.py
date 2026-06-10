#!/usr/bin/env python3
"""Build the WaymoNet training dataset from REAL data only (no synthetics).

Source of truth = the live system's own database. Every candidate row stores the full
352x288 frame AND the host-vehicle bbox, so human review labels detector-grade data as a
side effect:
  POSITIVES      = status='waymo' rows (user-confirmed real Waymos): frame + bbox -> YOLO label
  HARD NEGATIVES = status='reject' frames (user-vetted not-Waymo — every one of these FOOLED
                   the surfacer, so they are exactly the negatives the model must learn)
  PLAIN NEGATIVES= sent-but-unflagged 'new' frames older than IMPLICIT_DAYS (the user saw the
                   sheet and didn't flag them = implicit reject), sampled up to NEG_RATIO.
                   'near' frames are NEVER used as negatives — no human ever saw them, so one
                   could contain a sub-bar Waymo and we'd train the model to ignore it.

Split is BY CAMERA (whole feeds held out) — the only honest split at small n. With positives
on very few cameras the val estimate is weak; the script says so loudly rather than hiding it.

Usage: build_real_dataset.py [--db data/waymo.db] [--out data/dataset_real]
Run on the VPS (where waymo.db + candidate jpgs live), then rsync --out to the GPU box.
"""
import argparse
import json
import os
import random
import shutil
import sqlite3

import cv2

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VAL_FRACTION = 0.25   # fraction of positive-bearing cameras held out (>=1)
NEG_RATIO = 4.0       # negatives per positive (hard rejects first, implicit fills the rest)
IMPLICIT_DAYS = 2     # sent-unflagged older than this = implicit negative
SEED = 7


def yolo_line(bbox, w, h):
    x1, y1, x2, y2 = bbox
    return (f"0 {(x1 + x2) / 2 / w:.6f} {(y1 + y2) / 2 / h:.6f} "
            f"{(x2 - x1) / w:.6f} {(y2 - y1) / h:.6f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(BASE, "data", "waymo.db"))
    ap.add_argument("--out", default=os.path.join(BASE, "data", "dataset_real"))
    a = ap.parse_args()
    random.seed(SEED)
    con = sqlite3.connect(a.db, timeout=60)

    pos = [(cam, fp, json.loads(bb)) for cam, fp, bb in con.execute(
        "SELECT camera_id, frame_path, bbox FROM candidates WHERE status='waymo' "
        "AND bbox IS NOT NULL AND frame_path IS NOT NULL").fetchall()
        if fp and os.path.exists(fp)]
    hard = [(cam, fp) for cam, fp in con.execute(
        "SELECT camera_id, frame_path FROM candidates WHERE status='reject' "
        "AND frame_path IS NOT NULL").fetchall() if fp and os.path.exists(fp)]
    implicit = [(cam, fp) for cam, fp in con.execute(
        "SELECT camera_id, frame_path FROM candidates WHERE status='new' AND "
        "COALESCE(sent,0)=1 AND captured_at < datetime('now', ?) AND frame_path IS NOT NULL",
        (f"-{IMPLICIT_DAYS} days",)).fetchall() if fp and os.path.exists(fp)]

    if not pos:
        raise SystemExit("no confirmed Waymos in the DB yet — confirm candidates first "
                         "(live_capture.py --confirm <ids>)")

    pos_cams = sorted({c for c, _, _ in pos})
    random.Random(13).shuffle(pos_cams)
    val_cams = set(pos_cams[:max(1, int(len(pos_cams) * VAL_FRACTION))])
    if len(pos_cams) < 3:
        print(f"WARNING: positives exist on only {len(pos_cams)} camera(s) — the by-camera "
              f"val split is statistically weak. Treat val metrics as a smoke test, not truth, "
              f"until confirms span more cameras.")

    if os.path.isdir(a.out):
        shutil.rmtree(a.out)
    for s in ("train", "val"):
        os.makedirs(os.path.join(a.out, "images", s))
        os.makedirs(os.path.join(a.out, "labels", s))

    counts = {"train": {"pos": 0, "neg": 0}, "val": {"pos": 0, "neg": 0}}
    for i, (cam, fp, bbox) in enumerate(pos):
        s = "val" if cam in val_cams else "train"
        im = cv2.imread(fp)
        if im is None:
            continue
        name = f"waymo_{i:04d}"
        shutil.copy(fp, os.path.join(a.out, "images", s, name + ".jpg"))
        open(os.path.join(a.out, "labels", s, name + ".txt"), "w").write(
            yolo_line(bbox, im.shape[1], im.shape[0]) + "\n")
        counts[s]["pos"] += 1

    # negatives: ALL human-vetted rejects first (the high-value set), implicit fills the rest
    target = {s: int(counts[s]["pos"] * NEG_RATIO) for s in ("train", "val")}
    random.shuffle(implicit)
    seen = set()
    for kind, pool in (("hardneg", hard), ("neg", implicit)):
        for j, (cam, fp) in enumerate(pool):
            s = "val" if cam in val_cams else "train"
            if kind == "neg" and counts[s]["neg"] >= target[s]:
                continue
            if fp in seen:
                continue
            seen.add(fp)
            shutil.copy(fp, os.path.join(a.out, "images", s, f"{kind}_{j:05d}.jpg"))
            counts[s]["neg"] += 1   # no label file = background (Ultralytics convention)

    open(os.path.join(a.out, "dataset.yaml"), "w").write(
        f"# WaymoNet REAL dataset — built from waymo.db (confirms + vetted rejects).\n"
        f"# Powered by TfL Open Data.\n"
        f"path: {os.path.abspath(a.out)}\ntrain: images/train\nval: images/val\n"
        f"nc: 1\nnames:\n  0: waymo\n")

    print(f"dataset -> {a.out}")
    for s in ("train", "val"):
        print(f"  {s}: {counts[s]['pos']} real positives + {counts[s]['neg']} real negatives")
    print(f"  positive cameras: {len(pos_cams)} (val: {sorted(val_cams)})")
    print(f"  pools: {len(pos)} confirms | {len(hard)} vetted rejects | {len(implicit)} implicit")


if __name__ == "__main__":
    main()
