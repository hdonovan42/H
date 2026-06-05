#!/usr/bin/env python3
"""Trustworthy Waymo-dome vs Wayve-roof-rack separability across scales.

Now with ~42 real dome sources (vs the original 8) + curated genuine Wayve-rig cars,
a logistic-regression probe on MobileNetV3 embeddings, and SOURCE-GROUPED k-fold CV
(no leakage). Reports ROC-AUC + balanced accuracy per render scale (full-res -> 44px).
"""
import glob
import json
import os
import sys

import cv2
import numpy as np
from ultralytics import YOLO

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from separability_eval import build_embedder, augment  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOMES = sorted(glob.glob(os.path.join(BASE, "data/sources/domes/*.jpg")))
WAYVE_IDX = [1, 3, 5, 6, 7, 8, 10, 11, 12, 14, 15, 16, 17, 18]
SCALES = [None, 96, 72, 56, 44]
KFOLD = 5


def degrade(crop, wpx, q=38):
    if wpx is None:
        return crop
    h, w = crop.shape[:2]
    sm = cv2.resize(crop, (wpx, max(1, int(h * wpx / w))), interpolation=cv2.INTER_AREA)
    enc = cv2.imencode(".jpg", sm, [cv2.IMWRITE_JPEG_QUALITY, q])[1]
    return cv2.imdecode(enc, cv2.IMREAD_COLOR)


def wayve_roofs():
    paths = json.load(open(os.path.join(BASE, "data/sources/top_domelike_idx.json")))
    det = YOLO("yolo11n.pt")
    crops = []
    for i in WAYVE_IDX:
        im = cv2.imread(paths[i])
        if im is None:
            continue
        H, W = im.shape[:2]
        r = det.predict(im, conf=0.35, verbose=False)[0]
        cars = [b.xyxy[0].tolist() for b in r.boxes if int(b.cls[0]) == 2]
        if not cars:
            continue
        x1, y1, x2, y2 = map(int, max(cars, key=lambda b: (b[2] - b[0]) * (b[3] - b[1])))
        mx = int((x2 - x1) * 0.16)
        rc = im[max(0, int(y1 - (y2 - y1) * 0.06)):int(y1 + (y2 - y1) * 0.45),
                max(0, x1 + mx):min(W, x2 - mx)]
        if rc.size:
            crops.append(rc)
    return crops


def fit_logreg(X, y, iters=500, lr=0.5, l2=1e-2):
    mu, sd = X.mean(0), X.std(0) + 1e-6
    Xs = (X - mu) / sd
    w = np.zeros(Xs.shape[1]); b = 0.0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(Xs @ w + b)))
        g = p - y
        w -= lr * (Xs.T @ g / len(y) + l2 * w); b -= lr * g.mean()
    return w, b, mu, sd


def score_logreg(m, X):
    w, b, mu, sd = m
    return ((X - mu) / sd) @ w + b


def auc_bal(scores, labels):
    order = np.argsort(-scores)
    P, N = labels.sum(), (labels == 0).sum()
    tp = fp = 0; auc = prev = best = 0.0
    for i in order:
        tp += labels[i] == 1; fp += labels[i] == 0
        tpr, fpr = tp / P, fp / N
        auc += (fpr - prev) * tpr; prev = fpr
        best = max(best, 0.5 * (tpr + 1 - fpr))
    return auc, best


def main():
    embed = build_embedder()
    dome_imgs = [cv2.imread(f) for f in DOMES]
    wayve = wayve_roofs()
    print(f"clean sets: {len(dome_imgs)} dome sources, {len(wayve)} Wayve-rig sources; {KFOLD}-fold grouped CV\n")
    # assign each SOURCE to a fold
    rng = np.random.default_rng(0)
    dfold = rng.integers(0, KFOLD, len(dome_imgs))
    wfold = rng.integers(0, KFOLD, len(wayve))
    print(f"{'scale':>8} {'AUC':>6} {'bal-acc':>8}")
    for sc in SCALES:
        X, y, fold = [], [], []
        for i, im in enumerate(dome_imgs):
            for v in augment(im):
                X.append(embed(degrade(v, sc))); y.append(1); fold.append(dfold[i])
        for j, im in enumerate(wayve):
            for v in augment(im):
                X.append(embed(degrade(v, sc))); y.append(0); fold.append(wfold[j])
        X = np.array(X); y = np.array(y, float); fold = np.array(fold)
        scores, labels = [], []
        for k in range(KFOLD):
            tr, te = fold != k, fold == k
            if te.sum() == 0 or len(set(y[tr])) < 2:
                continue
            m = fit_logreg(X[tr], y[tr])
            scores += score_logreg(m, X[te]).tolist(); labels += y[te].astype(int).tolist()
        auc, bal = auc_bal(np.array(scores), np.array(labels))
        print(f"{(sc or 'full'):>8} {auc:>6.3f} {bal*100:>7.1f}%")


if __name__ == "__main__":
    main()
