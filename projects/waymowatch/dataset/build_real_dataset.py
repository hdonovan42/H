#!/usr/bin/env python3
"""Build the WaymoNet training dataset from REAL data only (no synthetics).

Source of truth = the live system's own database. Every candidate row stores the full
352x288 frame AND the host-vehicle bbox, so human review labels detector-grade data as a
side effect:
  POSITIVES = status='waymo' rows (user-confirmed real Waymos): frame + bbox -> YOLO label
  NEGATIVES = status='reject' frames ONLY — explicit human verdicts, highest score first
              (the hardest, most Waymo-like impostors are the most informative negatives).

EVERY training label is a human verdict — nothing unreviewed is ever trained on, in either
direction. No implicit negatives ('sent but unflagged' could hide a missed Waymo and we'd
teach the model to ignore it), no 'near' rows (never human-seen), no similarity screens
(a vetted verdict needs no second-guessing). Negative growth comes from the operational
pattern: user declares a reviewed sheet clean -> that page is banked as rejects.

Split is BY CAMERA (whole feeds held out) — the only honest split at small n. With positives
on very few cameras the val estimate is weak; the script says so loudly rather than hiding it.

Usage: build_real_dataset.py [--db data/waymo.db] [--out data/dataset_real]
Run on the VPS (where waymo.db + candidate jpgs live), then rsync --out to the GPU box.
"""
import argparse
import glob
import json
import os
import random
import shutil
import sqlite3

import cv2

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VAL_FRACTION = 0.25   # fraction of positive-bearing cameras held out (>=1)
NEG_RATIO = 6.0       # max ORDINARY negatives per positive — highest-scoring rejects first (hardest)
HARD_WEIGHT = 10      # TRAIN oversample for hard_negatives (the model's own FPs); val keeps them x1
SEED = 7


def yolo_line(bbox, w, h):
    x1, y1, x2, y2 = bbox
    return (f"0 {(x1 + x2) / 2 / w:.6f} {(y1 + y2) / 2 / h:.6f} "
            f"{(x2 - x1) / w:.6f} {(y2 - y1) / h:.6f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(BASE, "data", "waymo.db"))
    ap.add_argument("--out", default=os.path.join(BASE, "data", "dataset_real"))
    ap.add_argument("--hard-dir", default=os.path.join(BASE, "data", "hard_negatives"),
                    help="dir of hard-negative full frames (model's own FPs); weighted in TRAIN")
    ap.add_argument("--hard-weight", type=int, default=HARD_WEIGHT,
                    help=f"TRAIN oversample factor for hard negatives (default {HARD_WEIGHT}; for ablation)")
    a = ap.parse_args()
    random.seed(SEED)
    con = sqlite3.connect(a.db, timeout=60)

    # Group confirmed Waymos by (camera, captured_at) = ONE clip's ByteTrack pass, so MULTIPLE
    # Waymos in the same frame become ONE training image with MULTIPLE boxes (v0.8.58). Otherwise a
    # 2nd same-frame Waymo is an unlabelled positive region that teaches YOLO to SUPPRESS real
    # Waymos. (captured_at is stamped once per ingest() call, so it uniquely keys a single clip.)
    frames = {}
    for cam, at, fp, bb in con.execute(
            "SELECT camera_id, captured_at, frame_path, bbox FROM candidates WHERE status='waymo' "
            "AND special IS NULL "
            "AND bbox IS NOT NULL AND frame_path IS NOT NULL").fetchall():
        if not (fp and os.path.exists(fp)):
            continue
        g = frames.setdefault((cam, at), {"cam": cam, "fp": fp, "boxes": []})
        g["boxes"].append(json.loads(bb))
    pos = list(frames.values())   # each: {"cam", "fp" (one frame copy), "boxes": [bbox, ...]}
    # special IS NULL on BOTH classes: user-curated gallery cases are held OUT of training —
    # they are the manual post-train evaluation set (user, 2026-06-11). Negatives = hard confusers
    # (roof-box/i-pac/funny/van_roof); positives = confirmed-real but low-SNR/partial views
    # (edge_positive, 2026-06-18) that would dilute dome-specificity and manufacture FPs if trained
    # on — kept as eval-only true-positives for recall testing.
    # hard negatives = the model's OWN false positives, curated in data/hard_negatives/ (v2 set):
    # the highest-signal negatives (cars RUN_1 flagged as Waymos but the user rejected). They are
    # status='reject' too, so we pull them OUT of the ordinary pool and weight them in TRAIN (val
    # keeps them x1 — never oversample val). Match dir files -> DB rows by frame basename to recover
    # camera_id for the by-camera split (cam=None if no longer in the DB -> defaults to train).
    cam_by_base = {os.path.basename(fp): cam for cam, fp in con.execute(
        "SELECT camera_id, frame_path FROM candidates WHERE frame_path IS NOT NULL").fetchall() if fp}
    hard_files = sorted(glob.glob(os.path.join(a.hard_dir, "*_frame.jpg")))
    hard = [(cam_by_base.get(os.path.basename(f)), f) for f in hard_files if os.path.exists(f)]
    hard_base = {os.path.basename(f) for f in hard_files}

    # ordinary vetted rejects = explicit human rejects MINUS the hard set, hardest (highest-score) first.
    # The 13 RUN_1-recovered Waymos are status='waymo' now, so this status='reject' query excludes them.
    rejects = [(cam, fp) for cam, fp in con.execute(
        "SELECT camera_id, frame_path FROM candidates WHERE status='reject' "
        "AND special IS NULL "
        "AND frame_path IS NOT NULL ORDER BY score DESC").fetchall()
        if fp and os.path.exists(fp) and os.path.basename(fp) not in hard_base]

    if not pos:
        raise SystemExit("no confirmed Waymos in the DB yet — confirm candidates first "
                         "(live_capture.py --confirm <ids>)")

    pos_cams = sorted({g["cam"] for g in pos})
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
    multi, boxes_total = 0, 0
    for i, g in enumerate(pos):
        cam, fp, boxes = g["cam"], g["fp"], g["boxes"]
        s = "val" if cam in val_cams else "train"
        im = cv2.imread(fp)
        if im is None:
            continue
        name = f"waymo_{i:04d}"
        shutil.copy(fp, os.path.join(a.out, "images", s, name + ".jpg"))
        open(os.path.join(a.out, "labels", s, name + ".txt"), "w").write(
            "".join(yolo_line(b, im.shape[1], im.shape[0]) + "\n" for b in boxes))
        counts[s]["pos"] += 1            # one image per frame; a frame may carry several boxes
        boxes_total += len(boxes)
        if len(boxes) > 1:
            multi += 1

    # negatives: vetted rejects only, hardest (highest-scoring) first, capped per split
    target = {s: max(1, int(counts[s]["pos"] * NEG_RATIO)) for s in ("train", "val")}
    seen = set()
    for j, (cam, fp) in enumerate(rejects):
        s = "val" if cam in val_cams else "train"
        if counts[s]["neg"] >= target[s] or fp in seen:
            continue
        seen.add(fp)
        shutil.copy(fp, os.path.join(a.out, "images", s, f"neg_{j:05d}.jpg"))
        counts[s]["neg"] += 1   # no label file = background (Ultralytics convention)

    # hard negatives: model's own FPs — TRAIN x{hard_weight} (emphasis), VAL x1 (undistorted FP rate).
    hard_counts = {"train": 0, "val": 0}
    for j, (cam, fp) in enumerate(hard):
        s = "val" if cam in val_cams else "train"
        reps = a.hard_weight if s == "train" else 1
        for k in range(reps):
            shutil.copy(fp, os.path.join(a.out, "images", s, f"neghard_{j:05d}_{k:02d}.jpg"))
        counts[s]["neg"] += reps
        hard_counts[s] += reps

    open(os.path.join(a.out, "dataset.yaml"), "w").write(
        f"# WaymoNet REAL dataset — built from waymo.db (confirms + vetted rejects).\n"
        f"# Powered by TfL Open Data.\n"
        f"path: {os.path.abspath(a.out)}\ntrain: images/train\nval: images/val\n"
        f"nc: 1\nnames:\n  0: waymo\n")

    if counts["val"]["neg"] == 0:
        print("WARNING: no vetted negatives on the held-out cameras — eval_gate.py cannot "
              "measure FP rate. Review+bank a sheet covering the val cameras, then rebuild.")
    print(f"dataset -> {a.out}")
    print(f"  positive images: {len(pos)} frames carrying {boxes_total} Waymo boxes "
          f"({multi} multi-Waymo frame{'s' if multi != 1 else ''})")
    for s in ("train", "val"):
        print(f"  {s}: {counts[s]['pos']} real positives + {counts[s]['neg']} vetted negatives")
    print(f"  positive cameras: {len(pos_cams)} (val: {sorted(val_cams)})")
    print(f"  pools: {len(pos)} confirms | {len(rejects)} ordinary rejects "
          f"(hardest-first, capped {NEG_RATIO:.0f}:1) | {len(hard)} hard negatives (model FPs) "
          f"-> train x{a.hard_weight}={hard_counts['train']} + val x1={hard_counts['val']}")


if __name__ == "__main__":
    main()
