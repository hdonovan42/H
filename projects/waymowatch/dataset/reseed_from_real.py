#!/usr/bin/env python3
"""'Perfect the dome' — one command, the moment real positives exist.

Takes the confirmed REAL Waymo crops in data/real_positives/ (banked by
`live_capture.py --confirm <ids>`), re-crops their roofs at the live tight geometry,
and re-seeds the deployed centroid from genuine CCTV domes. With fewer than MIN_REAL
confirms, blends 50/50 with the current synthetic centroid for stability; from MIN_REAL
up, the centroid is pure real. Prints recalibrated thresholds from the cached plain
white-car embeddings (data/probe_cache.npz) and writes the live artifact
(collector/dome_centroid_tight.json) ready to rsync + loop-restart.

After the first confirm, also mine the silent near-miss archive (status='near') at the
sighting's time window — the same vehicle's sub-bar passes at other cameras are extra
real training views: SELECT * FROM candidates WHERE status='near' AND captured_at
BETWEEN <t-45min> AND <t+45min>.

Run:  .venv/bin/python dataset/reseed_from_real.py [--dry-run]
"""
import argparse
import glob
import json
import os
import sys
from datetime import date

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(BASE, "collector"))

from separability_eval import build_embedder, jamcam      # noqa: E402
from train_probe import carcrop_roof                      # noqa: E402
from live_capture import CENTROID_FILE                    # noqa: E402

REAL_DIR = os.path.join(BASE, "data", "real_positives")
CACHE = os.path.join(BASE, "data", "probe_cache.npz")
MIN_REAL = 5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print stats, don't write the artifact")
    a = ap.parse_args()

    crops = [f for f in sorted(glob.glob(os.path.join(REAL_DIR, "*.jpg")))
             if not f.endswith("_frame.jpg")]
    if not crops:
        sys.exit(f"no real positives in {REAL_DIR} yet — confirm one first "
                 "(live_capture.py --confirm <id>)")
    embed = build_embedder()
    embs = []
    for f in crops:
        im = cv2.imread(f)
        if im is None:
            continue
        rc = carcrop_roof(im)
        if rc.size and min(rc.shape[:2]) >= 4:
            embs.append(embed(jamcam(rc)))
            print(f"  + {os.path.basename(f)}")
    if not embs:
        sys.exit("no usable roof crops")

    real_c = np.mean(embs, 0)
    real_c /= np.linalg.norm(real_c) + 1e-8
    blended = len(embs) < MIN_REAL and os.path.exists(CENTROID_FILE)
    if blended:
        syn = np.array(json.load(open(CENTROID_FILE))["centroid"], dtype=np.float32)
        syn /= np.linalg.norm(syn) + 1e-8
        cen = real_c + syn
        cen /= np.linalg.norm(cen) + 1e-8
        print(f"\n{len(embs)} real < {MIN_REAL} -> blending 50/50 with synthetic centroid")
    else:
        cen = real_c
        print(f"\n{len(embs)} real positives -> PURE REAL centroid")

    if os.path.exists(CACHE):
        plains = np.load(CACHE, allow_pickle=True)["p"]
        neg = plains @ cen
        print("plain white-car scores vs new centroid (synthetic-host reference):")
        print(f"  p50 {np.percentile(neg, 50):.3f}  p95 {np.percentile(neg, 95):.3f}  "
              f"p99 {np.percentile(neg, 99):.3f}  max {neg.max():.3f}")
        print(f"  suggested: PROB_TH ~ p95 ({np.percentile(neg, 95):.2f}), "
              f"ALERT_TH ~ max + live-tail margin; RE-CHECK against live scores after a day")
        reals = np.array(embs) @ cen
        print(f"real-positive scores vs new centroid: min {reals.min():.3f}  "
              f"p50 {np.percentile(reals, 50):.3f} (in-sample — sanity only)")

    if a.dry_run:
        print("\n--dry-run: artifact NOT written")
        return
    json.dump({
        "built": date.today().isoformat(),
        "source": f"real({len(embs)})" + ("+synthetic_blend" if blended else ""),
        "centroid": [round(float(x), 5) for x in cen],
    }, open(CENTROID_FILE, "w"))
    print(f"\ncentroid -> {CENTROID_FILE}")
    print("deploy:  rsync -av collector/dome_centroid_tight.json hq@89.167.4.126:/home/hq/waymowatch/collector/"
          "\n         ssh hq@89.167.4.126 \"pkill -f 'live_capture.py --loop'\"   # supervisor restarts <=6 min"
          "\nthen update PROB_TH/ALERT_TH in collector/live_capture.py per the printed quantiles.")


if __name__ == "__main__":
    main()
