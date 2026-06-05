#!/usr/bin/env python3
"""Harvest white-non-Waymo NEGATIVES for the Stage-2 classifier.

Sweeps central-London JamCams, keeps DISTINCT white cars (Stage-1 filter), records each
crop's dome-similarity score, and STRATIFY-samples across the score range so the set is a
quality mix: high score = HARD negatives (white vehicles with roof structures / I-PACE-like
shapes that look dome-ish), low score = easy (plain white vans/cars). Whole-car crops, same
format as positives. Human vets the high-score band to pull any real Waymo before use.
"""
import argparse
import glob
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(BASE, "dataset"))
import data_plane as dp  # noqa: E402
from separability_eval import build_embedder, jamcam  # noqa: E402
from live_capture import is_white, dome_centroid, in_zone, MIN_H  # noqa: E402

OUT = os.path.join(BASE, "data", "stage2", "negatives")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cameras", type=int, default=50)
    ap.add_argument("--target", type=int, default=120)
    ap.add_argument("--sample-every", type=int, default=10)
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    from ultralytics import YOLO
    embed = build_embedder()
    cen = dome_centroid(embed)
    det = YOLO("yolo11n.pt")
    cams = dp.fetch_camera_list()
    zone = [c for c in cams if dp.props(c).get("available") == "true" and in_zone(c)]
    chosen = zone[:a.cameras]
    tmp = os.path.join(OUT, "_tmp.mp4")
    pool = []
    for cam in chosen:
        try:
            _, body, _ = dp.http_get(dp.props(cam).get("videoUrl"))
        except Exception:
            continue
        if not body:
            continue
        open(tmp, "wb").write(body)
        cap = cv2.VideoCapture(tmp)
        idx, seen = 0, []
        while True:
            ok, fr = cap.read()
            if not ok:
                break
            if idx % a.sample_every == 0:
                r = det.predict(fr, conf=0.30, verbose=False, imgsz=352)[0]
                for b in r.boxes:
                    if int(b.cls[0]) != 2:
                        continue
                    x1, y1, x2, y2 = map(int, b.xyxy[0].tolist())
                    if (y2 - y1) < MIN_H:
                        continue
                    if not is_white(fr[max(0, y1):y2, max(0, x1):x2]):
                        continue
                    mx = int((x2 - x1) * 0.16)
                    roof = fr[max(0, int(y1 - (y2 - y1) * 0.06)):int(y1 + (y2 - y1) * 0.45),
                              max(0, x1 + mx):min(fr.shape[1], x2 - mx)]
                    if roof.size == 0 or min(roof.shape[:2]) < 6:
                        continue
                    e = embed(jamcam(roof))
                    if seen and max(float(e @ s) for s in seen) > 0.96:
                        continue  # same vehicle already taken at this camera
                    seen.append(e)
                    hd = int((y2 - y1) * 0.12)
                    car = fr[max(0, y1 - hd):y2, max(0, x1):min(fr.shape[1], x2)]
                    pool.append((float(e @ cen), car.copy(), cam["id"].replace("JamCams_", "")))
            idx += 1
        cap.release()
    if os.path.exists(tmp):
        os.remove(tmp)
    print(f"pool: {len(pool)} distinct white cars from {len(chosen)} cams")
    if not pool:
        return
    pool.sort(key=lambda t: -t[0])
    n = min(a.target, len(pool))
    third = max(1, len(pool) // 3)
    bands = [pool[:third], pool[third:2 * third], pool[2 * third:]]
    quota = [int(n * 0.45), int(n * 0.30), n - int(n * 0.45) - int(n * 0.30)]
    negs = [x for band, q in zip(bands, quota) for x in band[:q]]
    for f in glob.glob(os.path.join(OUT, "*.jpg")):
        os.remove(f)
    for i, (sc, car, camid) in enumerate(negs):
        cv2.imwrite(os.path.join(OUT, f"neg_{i:03d}_{camid}_{int(sc * 100)}.jpg"), car)
    top = sorted(negs, key=lambda t: -t[0])[:24]
    cells = []
    for sc, car, camid in top:
        c = cv2.resize(car, (200, 150), interpolation=cv2.INTER_NEAREST)
        cv2.rectangle(c, (0, 0), (62, 18), (0, 0, 0), -1)
        cv2.putText(c, f"{sc:.2f}", (3, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
        cells.append(c)
    cells += [np.full((150, 200, 3), 35, np.uint8)] * ((-len(cells)) % 6)
    sheet = np.vstack([np.hstack(cells[i:i + 6]) for i in range(0, len(cells), 6)])
    cv2.imwrite(os.path.join(BASE, "data/stage2/negatives_top_sheet.jpg"), sheet)
    hard = sum(1 for s, _, _ in negs if s >= bands[0][-1][0]) if bands[0] else 0
    print(f"saved {len(negs)} negatives -> {OUT}  (hard/high-score band weighted ~45%)")
    print(f"VET the most dome-like 24 for any real Waymo -> data/stage2/negatives_top_sheet.jpg")


if __name__ == "__main__":
    main()
