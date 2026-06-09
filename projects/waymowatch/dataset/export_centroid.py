#!/usr/bin/env python3
"""Build the DEPLOYED surfacer centroid -> collector/dome_centroid_tight.json.

Centroid = normalised mean MobileNetV3 embedding of synthetic Waymo roof crops (real dome
pasted on every white manifest host, live tight geometry imported from live_capture so it
can never drift). Uses ALL cameras/hosts — this is the deployment artifact; the honest
generalisation numbers are dataset/reseed_centroid_eval.py's camera-split (AUC 0.839,
recall 33%/45% @ 1%/5% white-car pass-rate).

Also prints the white-car (unpasted) score distribution against the NEW centroid —
that's what PROB_TH / ALERT_TH in live_capture.py are calibrated from. Positive recall
printed here is in-sample (the centroid was built from these pastes); trust the split eval.

Run:  .venv/bin/python dataset/export_centroid.py
"""
import datetime
import glob
import json
import os
import random
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(BASE, "collector"))

from separability_eval import build_embedder, jamcam                       # noqa: E402
from make_synthetic import _alpha_for, synth_one                           # noqa: E402
from live_capture import (is_white, iou, roof_crop, CENTROID_FILE,         # noqa: E402
                          ROOF_TOP, ROOF_BOTTOM, ROOF_INSET, MIN_H)

MANIFEST = os.path.join(BASE, "data", "synthetic", "manifest.json")
DOMES_DIR = os.path.join(BASE, "data", "sources", "domes")
SEED = 1234


def detect_host(det, img, host):
    r = det.predict(img, conf=0.30, verbose=False, imgsz=352)[0]
    boxes = [tuple(map(int, b.xyxy[0].tolist())) for b in r.boxes if int(b.cls[0]) == 2]
    m = [b for b in boxes if iou(b, host) > 0.40 and (b[3] - b[1]) >= MIN_H]
    return max(m, key=lambda b: (b[2] - b[0]) * (b[3] - b[1])) if m else None


def main():
    random.seed(SEED)
    from ultralytics import YOLO
    det = YOLO(os.path.join(BASE, "yolo11n.pt"))
    embed = build_embedder()
    domes = [(cv2.imread(f), _alpha_for(cv2.imread(f)))
             for f in sorted(glob.glob(os.path.join(DOMES_DIR, "*.jpg")))]

    pos_e, neg_e, cams = [], [], set()
    k = 0
    for m in json.load(open(MANIFEST)):
        img = cv2.imread(os.path.join(BASE, m["source_frame"]))
        if img is None:
            continue
        host = tuple(m["host_bbox_xyxy"])
        x1, y1, x2, y2 = host
        if not is_white(img[max(0, y1):y2, max(0, x1):x2]):
            continue
        syn = synth_one(img, [host], domes, dome_pair=domes[k % len(domes)])
        k += 1
        if not syn:
            continue
        bb_p, bb_u = detect_host(det, syn[0], host), detect_host(det, img, host)
        if bb_p is None or bb_u is None:
            continue
        rp, ru = roof_crop(syn[0], bb_p), roof_crop(img, bb_u)
        if min(rp.shape[:2] + ru.shape[:2]) < 4:
            continue
        pos_e.append(embed(jamcam(rp)))
        neg_e.append(embed(jamcam(ru)))
        cams.add(m["camera"])
        if len(pos_e) % 40 == 0:
            print(f"  embedded {len(pos_e)} pairs …")

    cen = np.mean(pos_e, 0)
    cen = cen / (np.linalg.norm(cen) + 1e-8)
    pos = np.array([float(e @ cen) for e in pos_e])
    neg = np.array([float(e @ cen) for e in neg_e])

    print(f"\npairs: {len(pos_e)} | cameras: {len(cams)}")
    print(f"white-car (unpasted) scores vs new centroid — CALIBRATE THRESHOLDS FROM THIS:")
    for q in (50, 90, 95, 99):
        print(f"  p{q}: {np.percentile(neg, q):.3f}")
    print(f"  max: {neg.max():.3f}")
    print(f"synthetic-Waymo scores (IN-SAMPLE, optimistic): "
          f"p10/p50/p90 {np.percentile(pos, 10):.3f} / {np.percentile(pos, 50):.3f} / {np.percentile(pos, 90):.3f}")
    for th in (np.percentile(neg, 95), np.percentile(neg, 99), neg.max() + 0.01):
        print(f"  @ th {th:.3f}: white-car pass {np.mean(neg >= th) * 100:4.1f}% | in-sample recall {np.mean(pos >= th) * 100:4.1f}%")

    json.dump({
        "built": datetime.date.today().isoformat(),
        "n_pairs": len(pos_e), "n_cameras": len(cams),
        "geometry": {"top": ROOF_TOP, "bottom": ROOF_BOTTOM, "inset": ROOF_INSET},
        "neg_quantiles": {f"p{q}": round(float(np.percentile(neg, q)), 4) for q in (50, 90, 95, 99)},
        "neg_max": round(float(neg.max()), 4),
        "centroid": [round(float(x), 5) for x in cen],
    }, open(CENTROID_FILE, "w"))
    print(f"\ncentroid ({len(cen)}-d) -> {CENTROID_FILE}")


if __name__ == "__main__":
    main()
