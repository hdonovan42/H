#!/usr/bin/env python3
"""Test the 'any roof hardware' surfacer: centroid seeded from dome AND Wayve-bar pastes,
so BOTH fleets surface and the human review sheet does dome-vs-bar (easy by eye at >=44px).

Rationale: 'protrusion vs clean roof' may carry more embedding signal than 'dome vs world',
and a surfaced Wayve is acceptable (rare, visually distinct on the sheet) — recall on the
Waymo dome is what matters. Compares, on the SAME camera-grouped split as the shipped
centroid eval:
  A. dome-only centroid (the deployed scorer — baseline)
  B. hardware centroid (dome + wayve pastes)
  C. max(dome centroid, wayve centroid) two-template score
Embeddings are cached to data/probe_cache.npz on first run (~8 min); later runs are instant.

Run:  .venv/bin/python dataset/hardware_centroid_eval.py
"""
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

from separability_eval import build_embedder, jamcam        # noqa: E402
from make_synthetic import _alpha_for, synth_one            # noqa: E402
from live_capture import is_white, iou, roof_crop, MIN_H    # noqa: E402

MANIFEST = os.path.join(BASE, "data", "synthetic", "manifest.json")
DOMES_DIR = os.path.join(BASE, "data", "sources", "domes")
RACKS_DIR = os.path.join(BASE, "data", "sources", "wayve_rack")
CACHE = os.path.join(BASE, "data", "probe_cache.npz")
WAYVE_FRAC = 0.55
SEED = 1234


def collect():
    from ultralytics import YOLO
    det = YOLO(os.path.join(BASE, "yolo11n.pt"))
    embed = build_embedder()
    domes = [(cv2.imread(f), _alpha_for(cv2.imread(f)))
             for f in sorted(glob.glob(os.path.join(DOMES_DIR, "*.jpg")))]
    racks = [(cv2.imread(f), _alpha_for(cv2.imread(f)))
             for f in sorted(glob.glob(os.path.join(RACKS_DIR, "*.jpg")))]

    def detect_host(img, host):
        r = det.predict(img, conf=0.30, verbose=False, imgsz=352)[0]
        boxes = [tuple(map(int, b.xyxy[0].tolist())) for b in r.boxes if int(b.cls[0]) == 2]
        m = [b for b in boxes if iou(b, host) > 0.40 and (b[3] - b[1]) >= MIN_H]
        return max(m, key=lambda b: (b[2] - b[0]) * (b[3] - b[1])) if m else None

    def roof_emb(img, host):
        bb = detect_host(img, host)
        if bb is None:
            return None
        rc = roof_crop(img, bb)
        return embed(jamcam(rc)) if rc.size and min(rc.shape[:2]) >= 4 else None

    cams, E_d, E_p, E_w = [], [], [], []
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
        e_d, e_p, e_w = roof_emb(sd_[0], host), roof_emb(img, host), roof_emb(sw[0], host)
        if e_d is None or e_p is None or e_w is None:
            continue
        cams.append(m["camera"]); E_d.append(e_d); E_p.append(e_p); E_w.append(e_w)
        if len(cams) % 40 == 0:
            print(f"  embedded {len(cams)} host triples …")
    np.savez(CACHE, cams=np.array(cams), d=np.array(E_d), p=np.array(E_p), w=np.array(E_w))


def centroid(E):
    c = E.mean(0)
    return c / (np.linalg.norm(c) + 1e-8)


def report(name, pos_d, pos_w, neg):
    auc = (pos_d[:, None] > neg[None, :]).mean() + 0.5 * (pos_d[:, None] == neg[None, :]).mean()
    print(f"\n--- {name} ---")
    print(f"AUC dome-vs-plain: {auc:.3f}")
    for fpr in (0.01, 0.05):
        th = float(np.quantile(neg, 1 - fpr))
        print(f"  @ {fpr * 100:.0f}% white-car pass (th {th:.3f}): dome recall {(pos_d >= th).mean() * 100:5.1f}% | "
              f"wayve surfaces {(pos_w >= th).mean() * 100:5.1f}%")


def main():
    random.seed(SEED)
    if not os.path.exists(CACHE):
        collect()
    z = np.load(CACHE, allow_pickle=True)
    cams, D, P, W = z["cams"], z["d"], z["p"], z["w"]
    uc = sorted(set(cams.tolist()))
    seed_mask = np.isin(cams, np.array(uc[0::2]))
    ev = ~seed_mask
    print(f"hosts: {len(cams)} | cams: {len(uc)} | seed {seed_mask.sum()} / eval {ev.sum()}")

    cd = centroid(D[seed_mask])                                  # A: dome-only (deployed)
    ch = centroid(np.vstack([D[seed_mask], W[seed_mask]]))       # B: hardware (dome+bar)
    cw = centroid(W[seed_mask])                                  # C: two-template max
    report("A: dome centroid (deployed baseline)", D[ev] @ cd, W[ev] @ cd, P[ev] @ cd)
    report("B: hardware centroid (dome+bar)", D[ev] @ ch, W[ev] @ ch, P[ev] @ ch)
    pos_d = np.maximum(D[ev] @ cd, D[ev] @ cw)
    pos_w = np.maximum(W[ev] @ cd, W[ev] @ cw)
    neg = np.maximum(P[ev] @ cd, P[ev] @ cw)
    report("C: max(dome, wayve) two-template", pos_d, pos_w, neg)


if __name__ == "__main__":
    main()
