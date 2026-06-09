#!/usr/bin/env python3
"""Zero-cost surfacer upgrade: TRAINED logistic probe vs the mean-centroid scorer.

Same funnel, same embeddings, same runtime (one dot product) — but the scoring vector is
LEARNED instead of a class mean, and it is trained to reject the two things the centroid
can't: ordinary white-car roofs AND Wayve sensor bars (the London confuser, pasted at
~0.55 vehicle-width vs the dome's 0.34).

Data: per white manifest host, three tight roof-crop embeddings via the live funnel —
dome-pasted (label 1), unpasted (label 0), wayve-bar-pasted (label 0).
Eval: camera-grouped split (alternating cams, identical to reseed_centroid_eval.py, so the
AUC is directly comparable to the centroid's 0.839). Plus a REAL-data negative check: the
banked Stage-2 white-car negatives (data/stage2/negatives), eval-only, never trained on.
Deploy artifact (fit on ALL hosts): collector/roof_probe.json {w, b, mu, sd} + the plain
white-car probability quantiles PROB_TH / ALERT_TH are calibrated from.

Run:  .venv/bin/python dataset/train_probe.py
"""
import glob
import json
import os
import random
import sys
from datetime import date

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(BASE, "collector"))

from separability_eval import build_embedder, jamcam                # noqa: E402
from separability_scale_eval import fit_logreg, score_logreg        # noqa: E402
from make_synthetic import _alpha_for, synth_one                    # noqa: E402
from live_capture import is_white, iou, roof_crop, MIN_H            # noqa: E402

MANIFEST = os.path.join(BASE, "data", "synthetic", "manifest.json")
DOMES_DIR = os.path.join(BASE, "data", "sources", "domes")
RACKS_DIR = os.path.join(BASE, "data", "sources", "wayve_rack")
STAGE2_NEG = os.path.join(BASE, "data", "stage2", "negatives")
PROBE_FILE = os.path.join(BASE, "collector", "roof_probe.json")
WAYVE_FRAC = 0.55   # bar spans ~half the roof vs the dome's 0.34
SEED = 1234


def detect_host(det, img, host):
    r = det.predict(img, conf=0.30, verbose=False, imgsz=352)[0]
    boxes = [tuple(map(int, b.xyxy[0].tolist())) for b in r.boxes if int(b.cls[0]) == 2]
    m = [b for b in boxes if iou(b, host) > 0.40 and (b[3] - b[1]) >= MIN_H]
    return max(m, key=lambda b: (b[2] - b[0]) * (b[3] - b[1])) if m else None


def roof_emb(det, embed, img, host):
    bb = detect_host(det, img, host)
    if bb is None:
        return None
    rc = roof_crop(img, bb)
    return embed(jamcam(rc)) if rc.size and min(rc.shape[:2]) >= 4 else None


def carcrop_roof(im):
    """Approximate the live tight roof crop inside a SAVED candidate car crop
    (saved as frame[y1 - 0.12h : y2, x1 : x2] -> vehicle top sits at ~0.107 * crop height)."""
    H, W = im.shape[:2]
    mx = int(W * 0.28)
    return im[int(0.054 * H):int(0.303 * H), mx:W - mx]


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def main():
    random.seed(SEED)
    from ultralytics import YOLO
    det = YOLO(os.path.join(BASE, "yolo11n.pt"))
    embed = build_embedder()
    domes = [(cv2.imread(f), _alpha_for(cv2.imread(f)))
             for f in sorted(glob.glob(os.path.join(DOMES_DIR, "*.jpg")))]
    racks = [(cv2.imread(f), _alpha_for(cv2.imread(f)))
             for f in sorted(glob.glob(os.path.join(RACKS_DIR, "*.jpg")))]
    print(f"templates: {len(domes)} domes, {len(racks)} wayve racks")

    rows = []   # {camera, dome, plain, wayve}
    k = 0
    for m in json.load(open(MANIFEST)):
        img = cv2.imread(os.path.join(BASE, m["source_frame"]))
        if img is None:
            continue
        host = tuple(m["host_bbox_xyxy"])
        x1, y1, x2, y2 = host
        if not is_white(img[max(0, y1):y2, max(0, x1):x2]):
            continue
        sd_ = synth_one(img, [host], domes, dome_pair=domes[k % len(domes)])
        sw = synth_one(img, [host], racks, dome_pair=racks[k % len(racks)], target_frac=WAYVE_FRAC)
        k += 1
        if not sd_ or not sw:
            continue
        e_d = roof_emb(det, embed, sd_[0], host)
        e_p = roof_emb(det, embed, img, host)
        e_w = roof_emb(det, embed, sw[0], host)
        if e_d is None or e_p is None or e_w is None:
            continue
        rows.append({"camera": m["camera"], "dome": e_d, "plain": e_p, "wayve": e_w})
        if len(rows) % 40 == 0:
            print(f"  embedded {len(rows)} host triples …")

    cams = sorted({r["camera"] for r in rows})
    tr = [r for r in rows if r["camera"] in set(cams[0::2])]
    ev = [r for r in rows if r["camera"] not in set(cams[0::2])]
    print(f"hosts: {len(rows)} | cams: {len(cams)} | train {len(tr)} / eval {len(ev)}")

    def xy(rs):
        X = np.array([r["dome"] for r in rs] + [r["plain"] for r in rs] + [r["wayve"] for r in rs])
        y = np.array([1] * len(rs) + [0] * len(rs) + [0] * len(rs))
        return X, y

    Xtr, ytr = xy(tr)
    model = fit_logreg(Xtr, ytr, iters=800)
    pos = sigmoid(score_logreg(model, np.array([r["dome"] for r in ev])))
    pla = sigmoid(score_logreg(model, np.array([r["plain"] for r in ev])))
    way = sigmoid(score_logreg(model, np.array([r["wayve"] for r in ev])))

    auc_plain = (pos[:, None] > pla[None, :]).mean() + 0.5 * (pos[:, None] == pla[None, :]).mean()
    auc_wayve = (pos[:, None] > way[None, :]).mean() + 0.5 * (pos[:, None] == way[None, :]).mean()
    print(f"\n=== camera-split eval (centroid baseline: AUC 0.839, recall 33%@1% / 45%@5%) ===")
    print(f"AUC dome-vs-plain-white: {auc_plain:.3f}")
    print(f"AUC dome-vs-wayve-bar:   {auc_wayve:.3f}")
    for fpr in (0.01, 0.05):
        th = float(np.quantile(pla, 1 - fpr))
        print(f"  @ {fpr * 100:.0f}% white-car pass (th {th:.3f}): dome recall {(pos >= th).mean() * 100:5.1f}% | "
              f"wayve pass {(way >= th).mean() * 100:5.1f}%")

    # deploy fit on ALL hosts + real-negative check
    Xall, yall = xy(rows)
    final = fit_logreg(Xall, yall, iters=800)
    pla_all = sigmoid(score_logreg(final, np.array([r["plain"] for r in rows])))
    pos_all = sigmoid(score_logreg(final, np.array([r["dome"] for r in rows])))

    hard = []
    for f in sorted(glob.glob(os.path.join(STAGE2_NEG, "*.jpg"))):
        im = cv2.imread(f)
        if im is None:
            continue
        rc = carcrop_roof(im)
        if rc.size and min(rc.shape[:2]) >= 4:
            hard.append(sigmoid(float(score_logreg(final, embed(jamcam(rc))[None, :])[0])))
    hard = np.array(hard)

    print(f"\n=== deploy fit (all {len(rows)} hosts) ===")
    print(f"plain white-car probs: p50 {np.percentile(pla_all, 50):.3f}  p95 {np.percentile(pla_all, 95):.3f}  "
          f"p99 {np.percentile(pla_all, 99):.3f}  max {pla_all.max():.3f}")
    print(f"dome probs (in-sample): p10 {np.percentile(pos_all, 10):.3f}  p50 {np.percentile(pos_all, 50):.3f}")
    if len(hard):
        print(f"REAL stage2 negatives (n={len(hard)}, eval-only): p50 {np.percentile(hard, 50):.3f}  "
              f"p95 {np.percentile(hard, 95):.3f}  max {hard.max():.3f}")
    w, b, mu, sd_v = final
    json.dump({
        "built": date.today().isoformat(), "n_hosts": len(rows), "n_cameras": len(cams),
        "split_auc_plain": round(float(auc_plain), 4), "split_auc_wayve": round(float(auc_wayve), 4),
        "plain_q": {f"p{q}": round(float(np.percentile(pla_all, q)), 4) for q in (50, 90, 95, 99)},
        "plain_max": round(float(pla_all.max()), 4),
        "hard_neg_q95": round(float(np.percentile(hard, 95)), 4) if len(hard) else None,
        "hard_neg_max": round(float(hard.max()), 4) if len(hard) else None,
        "w": [round(float(x), 6) for x in w], "b": round(float(b), 6),
        "mu": [round(float(x), 6) for x in mu], "sd": [round(float(x), 6) for x in sd_v],
    }, open(PROBE_FILE, "w"))
    print(f"\nprobe -> {PROBE_FILE}")


if __name__ == "__main__":
    main()
