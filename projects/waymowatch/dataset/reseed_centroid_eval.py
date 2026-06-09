#!/usr/bin/env python3
"""Can the blind surfacer be rescued WITHOUT a trained model?

recall_eval.py showed the live funnel scores a dome'd car only +0.016 over the same car
bare — the tight-dome-crop centroid doesn't transfer to the live roof-crop geometry.
This tests the two cheap fixes, honestly (camera-grouped split, no leakage):

  1. RE-SEED: build the centroid from synthetic ROOF CROPS (dome pasted, live geometry)
     of cameras in the seed half; score pasted vs unpasted roof crops of the other half.
  2. TIGHT GEOMETRY: same, but with a tighter roof crop (top ~22% of car, 28% inset)
     for BOTH centroid and scoring — the dome fills more of the embedded image.

Reports ROC-AUC pasted-vs-unpasted per geometry + recall at thresholds set to 1% / 5%
unpasted-pass-rate (the relevant operating points for digest volume).

Run:  .venv/bin/python dataset/reseed_centroid_eval.py
"""
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

from separability_eval import build_embedder, jamcam   # noqa: E402
from make_synthetic import _alpha_for, synth_one       # noqa: E402
from live_capture import is_white, iou                 # noqa: E402

MANIFEST = os.path.join(BASE, "data", "synthetic", "manifest.json")
DOMES_DIR = os.path.join(BASE, "data", "sources", "domes")
SEED = 1234


def roof_live(frm, b):
    x1, y1, x2, y2 = b
    mx = int((x2 - x1) * 0.16)
    return frm[max(0, int(y1 - (y2 - y1) * 0.06)):int(y1 + (y2 - y1) * 0.45),
               max(0, x1 + mx):min(frm.shape[1], x2 - mx)]


def roof_tight(frm, b):
    x1, y1, x2, y2 = b
    mx = int((x2 - x1) * 0.28)
    return frm[max(0, int(y1 - (y2 - y1) * 0.06)):int(y1 + (y2 - y1) * 0.22),
               max(0, x1 + mx):min(frm.shape[1], x2 - mx)]


GEOMS = {"live(45%)": roof_live, "tight(22%)": roof_tight}


def detect_host(det, img, host):
    r = det.predict(img, conf=0.30, verbose=False, imgsz=352)[0]
    boxes = [tuple(map(int, b.xyxy[0].tolist())) for b in r.boxes if int(b.cls[0]) == 2]
    m = [b for b in boxes if iou(b, host) > 0.40 and (b[3] - b[1]) >= 44]
    return max(m, key=lambda b: (b[2] - b[0]) * (b[3] - b[1])) if m else None


def main():
    random.seed(SEED)
    from ultralytics import YOLO
    det = YOLO(os.path.join(BASE, "yolo11n.pt"))
    embed = embed_fn = build_embedder()

    import glob
    domes = [(cv2.imread(f), _alpha_for(cv2.imread(f)))
             for f in sorted(glob.glob(os.path.join(DOMES_DIR, "*.jpg")))]

    manifest = json.load(open(MANIFEST))
    random.shuffle(manifest)
    rows = []   # camera, geom -> (emb_pasted, emb_unpasted)
    for k, m in enumerate(manifest):
        img = cv2.imread(os.path.join(BASE, m["source_frame"]))
        if img is None:
            continue
        host = tuple(m["host_bbox_xyxy"])
        x1, y1, x2, y2 = host
        if not is_white(img[max(0, y1):y2, max(0, x1):x2]):
            continue
        syn = synth_one(img, [host], domes, dome_pair=domes[k % len(domes)])
        if not syn:
            continue
        comp = syn[0]
        bb_p, bb_u = detect_host(det, comp, host), detect_host(det, img, host)
        if bb_p is None or bb_u is None:
            continue
        rec = {"camera": m["camera"]}
        ok = True
        for g, fn in GEOMS.items():
            rp, ru = fn(comp, bb_p), fn(img, bb_u)
            if rp.size == 0 or ru.size == 0 or min(rp.shape[:2]) < 4 or min(ru.shape[:2]) < 4:
                ok = False
                break
            rec[g] = (embed_fn(jamcam(rp)), embed_fn(jamcam(ru)))
        if ok:
            rows.append(rec)
        if len(rows) % 40 == 0 and rows:
            print(f"  embedded {len(rows)} …")

    cams = sorted({r["camera"] for r in rows})
    seed_cams = set(cams[0::2])
    seed = [r for r in rows if r["camera"] in seed_cams]
    ev = [r for r in rows if r["camera"] not in seed_cams]
    print(f"pairs: {len(rows)} | cameras: {len(cams)} | seed {len(seed)} / eval {len(ev)}")

    out = {}
    for g in GEOMS:
        c = np.mean([r[g][0] for r in seed], 0)
        c /= np.linalg.norm(c) + 1e-8
        pos = np.array([float(r[g][0] @ c) for r in ev])
        neg = np.array([float(r[g][1] @ c) for r in ev])
        auc = (pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean()
        print(f"\n--- {g} (re-seeded centroid, camera-split) ---")
        print(f"pasted   p10/p50/p90: {np.percentile(pos, 10):.3f} / {np.percentile(pos, 50):.3f} / {np.percentile(pos, 90):.3f}")
        print(f"unpasted p10/p50/p90: {np.percentile(neg, 10):.3f} / {np.percentile(neg, 50):.3f} / {np.percentile(neg, 90):.3f}")
        print(f"ROC-AUC pasted-vs-unpasted: {auc:.3f}")
        for fpr in (0.01, 0.05):
            th = float(np.quantile(neg, 1 - fpr))
            print(f"  @ {fpr * 100:.0f}% white-car pass-rate: threshold {th:.3f} -> recall {(pos >= th).mean() * 100:.1f}%")
        out[g] = {"auc": float(auc), "pos_p50": float(np.percentile(pos, 50)),
                  "neg_p50": float(np.percentile(neg, 50))}

    json.dump(out, open(os.path.join(BASE, "data", "reseed_eval.json"), "w"), indent=1)
    print(f"\n-> data/reseed_eval.json")


if __name__ == "__main__":
    main()
