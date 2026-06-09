#!/usr/bin/env python3
"""End-to-end recall test for the LIVE surfacer funnel — answers "if a real Waymo drove
past a JamCam, would live_capture.py actually surface it?"

Method: take the manifest's real host vehicles (real cars, real frames, real angles),
keep only the ones that pass `is_white` (a Waymo host is a white I-PACE), paste a real
dome on the roof (the copy-paste engine's exact geometry), degrade to the JamCam domain,
then push the composite through the EXACT live scoring path imported from
collector/live_capture.py:

    YOLO11n predict (conf .30, imgsz 352, car class) -> height >= MIN_H gate ->
    is_white -> live roof_crop() -> MobileNetV3 embed -> cosine vs load_centroid()

Paired baseline: every host is also scored UNPASTED through the same path, so we get the
dome's marginal contribution at CCTV scale, paired per vehicle.

CAVEAT: the deployed centroid was seeded from these same synthetic pastes
(export_centroid.py), so positive recall here is IN-SAMPLE / optimistic. The honest
generalisation estimate is dataset/reseed_centroid_eval.py's camera-grouped split
(AUC 0.839; recall 33% / 45% at 1% / 5% white-car pass-rate). This script is the
regression harness for the funnel as shipped: stage losses, score scale, thresholds.

History: against the PRE-FIX funnel (45% roof crop, raw-dome-photo centroid) this measured
end-to-end recall 2.5% @ 0.82 and paired dome lift +0.016 — the surfacer was blind.

Run:  .venv/bin/python dataset/recall_eval.py [--n 300] [--seed 1234]
"""
import argparse
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

from separability_eval import build_embedder, jamcam                  # noqa: E402
from make_synthetic import _alpha_for, synth_one                      # noqa: E402
from live_capture import (is_white, iou, roof_crop, load_centroid,    # noqa: E402
                          MIN_H, PROB_TH, ALERT_TH)

MANIFEST = os.path.join(BASE, "data", "synthetic", "manifest.json")
DOMES_DIR = os.path.join(BASE, "data", "sources", "domes")
OUT_JSON = os.path.join(BASE, "data", "recall_eval.json")
HEIGHT_BINS = [(44, 60), (60, 80), (80, 1000)]


def score_through_funnel(det, embed, img, host_bbox, centroid):
    """Run one image through the live per-detection path. Returns (stage, score):
    stage in {detect, gate, white, roof, scored}; score only when stage == 'scored'."""
    r = det.predict(img, conf=0.30, verbose=False, imgsz=352)[0]
    boxes = [tuple(map(int, b.xyxy[0].tolist())) for b in r.boxes if int(b.cls[0]) == 2]
    match = [b for b in boxes if iou(b, host_bbox) > 0.40]
    if not match:
        return "detect", None
    bbox = max(match, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
    if (bbox[3] - bbox[1]) < MIN_H:
        return "gate", None
    x1, y1, x2, y2 = bbox
    if not is_white(img[max(0, y1):y2, max(0, x1):x2]):
        return "white", None
    roof = roof_crop(img, bbox)
    if roof.size == 0 or min(roof.shape[:2]) < 6:
        return "roof", None
    e = embed(jamcam(roof))
    return "scored", float(e @ centroid)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=300, help="max composites to score")
    ap.add_argument("--seed", type=int, default=1234)
    a = ap.parse_args()
    random.seed(a.seed)

    from ultralytics import YOLO
    det = YOLO(os.path.join(BASE, "yolo11n.pt"))
    embed = build_embedder()
    cen = load_centroid()

    domes = [(cv2.imread(f), _alpha_for(cv2.imread(f)))
             for f in sorted(glob.glob(os.path.join(DOMES_DIR, "*.jpg")))]
    print(f"dome templates: {len(domes)}")

    manifest = json.load(open(MANIFEST))
    random.shuffle(manifest)

    # white-host prefilter: a Waymo host is white; only those frames emulate one honestly
    hosts = []
    for m in manifest:
        img = cv2.imread(os.path.join(BASE, m["source_frame"]))
        if img is None:
            continue
        x1, y1, x2, y2 = m["host_bbox_xyxy"]
        if is_white(img[max(0, y1):y2, max(0, x1):x2]):
            hosts.append((m, img))
        if len(hosts) >= a.n:
            break
    print(f"white hosts: {len(hosts)} / {len(manifest)} manifest entries scanned")

    funnel = {"detect": 0, "gate": 0, "white": 0, "roof": 0, "scored": 0}
    results = []
    for k, (m, img) in enumerate(hosts):
        di = k % len(domes)                       # round-robin -> every template tested
        host = tuple(m["host_bbox_xyxy"])
        syn = synth_one(img, [host], domes, dome_pair=domes[di])
        if not syn:
            continue
        composite, _, _ = syn
        stage, s_pos = score_through_funnel(det, embed, composite, host, cen)
        funnel[stage] += 1
        rec = {"name": m["name"], "h": host[3] - host[1], "dome": di, "stage": stage, "score": s_pos}
        if stage == "scored":
            st0, s_neg = score_through_funnel(det, embed, img, host, cen)
            rec["score_unpasted"] = s_neg if st0 == "scored" else None
        results.append(rec)
        if (k + 1) % 50 == 0:
            print(f"  {k + 1}/{len(hosts)} …")

    scored = [r for r in results if r["stage"] == "scored"]
    pos = np.array([r["score"] for r in scored])
    neg = np.array([r["score_unpasted"] for r in scored if r.get("score_unpasted") is not None])
    n_all = len(results)

    print("\n=== funnel (synthetic Waymo = white host + real dome, DEPLOYED centroid — in-sample) ===")
    print(f"composites:            {n_all}")
    print(f"lost at detection:     {funnel['detect']}")
    print(f"lost at >=44px gate:   {funnel['gate']}")
    print(f"lost at is_white:      {funnel['white']}")
    print(f"lost at roof crop:     {funnel['roof']}")
    print(f"reached scoring:       {funnel['scored']}")
    if len(pos):
        print("\n=== scores ===")
        print(f"pasted   p10/p50/p90:  {np.percentile(pos, 10):.3f} / {np.percentile(pos, 50):.3f} / {np.percentile(pos, 90):.3f}")
        if len(neg):
            print(f"unpasted p10/p50/p90:  {np.percentile(neg, 10):.3f} / {np.percentile(neg, 50):.3f} / {np.percentile(neg, 90):.3f}")
            paired = [r["score"] - r["score_unpasted"] for r in scored if r.get("score_unpasted") is not None]
            print(f"paired dome lift:      median {np.median(paired):+.3f}")
        e2e_lo = (pos >= PROB_TH).sum() / n_all
        e2e_hi = (pos >= ALERT_TH).sum() / n_all
        print(f"\nrecall@{PROB_TH:.2f} (digest):  {(pos >= PROB_TH).mean() * 100:.1f}% of scored | {e2e_lo * 100:.1f}% end-to-end")
        print(f"recall@{ALERT_TH:.2f} (instant): {(pos >= ALERT_TH).mean() * 100:.1f}% of scored | {e2e_hi * 100:.1f}% end-to-end")
        print("\n=== by host height ===")
        for lo, hi in HEIGHT_BINS:
            sub = [r for r in scored if lo <= r["h"] < hi]
            nb = len([r for r in results if lo <= r["h"] < hi])
            if not sub:
                print(f"  {lo:>3}-{hi if hi < 1000 else '+':<3} px: 0 scored / {nb}")
                continue
            ps = np.array([r["score"] for r in sub])
            print(f"  {lo:>3}-{hi if hi < 1000 else '+':<3} px: n={nb:<3} p50={np.percentile(ps, 50):.3f} "
                  f"recall@{PROB_TH:.2f}={(ps >= PROB_TH).sum() / nb * 100:5.1f}%  "
                  f"recall@{ALERT_TH:.2f}={(ps >= ALERT_TH).sum() / nb * 100:5.1f}%")

    json.dump({"funnel": funnel, "results": results,
               "prob_th": PROB_TH, "alert_th": ALERT_TH, "seed": a.seed},
              open(OUT_JSON, "w"), indent=1)
    print(f"\nfull results -> {OUT_JSON}")


if __name__ == "__main__":
    main()
