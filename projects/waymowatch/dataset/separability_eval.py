#!/usr/bin/env python3
"""Quantify Waymo-dome vs Wayve/flat-roof separability at JamCam scale (CPU, no GPU).

Gate for the user's criterion: >=90% distinguishability justifies putting Wayve in the
training set. Method: real dome roof crops vs real Wayve/ordinary roof crops, BOTH pushed
through the same JamCam degrade (downscale to ~50px + JPEG) so the only signal is dome-vs-flat
(no domain tell). Embed with a pretrained MobileNetV3-Small, classify by nearest class-centroid
(cosine), evaluated with leave-one-DOME-SOURCE-out CV so it must generalise to unseen domes.
Reports ROC-AUC + balanced accuracy + dome recall + flat specificity.
"""
import glob
import os

import cv2
import numpy as np

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOMES = sorted(glob.glob(os.path.join(BASE, "data/sources/domes/*.jpg")))
FLATS = sorted(glob.glob(os.path.join(BASE, "data/sources/wayve_roofs/*.jpg")))
JAMCAM_W = 50


def jamcam(crop, wpx=JAMCAM_W, q=38):
    h, w = crop.shape[:2]
    sm = cv2.resize(crop, (wpx, max(1, int(h * wpx / w))), interpolation=cv2.INTER_AREA)
    enc = cv2.imencode(".jpg", sm, [cv2.IMWRITE_JPEG_QUALITY, q])[1]
    return cv2.imdecode(enc, cv2.IMREAD_COLOR)


def augment(crop):
    """Light variants so each dome SOURCE yields several embeddings (source kept for CV)."""
    outs = [crop, cv2.flip(crop, 1)]
    for b in (0.8, 1.2):
        outs.append(np.clip(crop.astype(np.float32) * b, 0, 255).astype(np.uint8))
    return outs


def build_embedder():
    import torch
    from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights
    w = MobileNet_V3_Small_Weights.IMAGENET1K_V1
    model = mobilenet_v3_small(weights=w)
    model.classifier = torch.nn.Identity()
    model.eval()
    tf = w.transforms()

    def embed(bgr):
        from PIL import Image
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        x = tf(Image.fromarray(rgb)).unsqueeze(0)
        with torch.no_grad():
            f = model(x).squeeze(0).numpy()
        return f / (np.linalg.norm(f) + 1e-8)
    return embed


def main():
    embed = build_embedder()
    # feature matrix with (feat, label, source_id); dome label=1
    X, y, src = [], [], []
    for i, f in enumerate(DOMES):
        im = cv2.imread(f)
        for v in augment(im):
            X.append(embed(jamcam(v))); y.append(1); src.append(f"dome{i}")
    for j, f in enumerate(FLATS):
        im = cv2.imread(f)
        if im is None:
            continue
        X.append(embed(jamcam(im))); y.append(0); src.append(f"flat{j}")
    X = np.array(X); y = np.array(y); src = np.array(src)
    dome_sources = sorted(set(s for s in src if s.startswith("dome")))
    flat_idx = np.where(y == 0)[0]

    # leave-one-dome-source-out; flats round-robined into the same number of folds
    rng = np.random.default_rng(0)
    flat_perm = rng.permutation(flat_idx)
    flat_folds = np.array_split(flat_perm, len(dome_sources))
    scores, labels = [], []
    for k, ds in enumerate(dome_sources):
        test_mask = (src == ds)
        test_flats = flat_folds[k]
        test_idx = np.where(test_mask)[0].tolist() + test_flats.tolist()
        train_idx = [i for i in range(len(y)) if i not in set(test_idx)]
        Xtr, ytr = X[train_idx], y[train_idx]
        c_dome = Xtr[ytr == 1].mean(0); c_dome /= np.linalg.norm(c_dome) + 1e-8
        c_flat = Xtr[ytr == 0].mean(0); c_flat /= np.linalg.norm(c_flat) + 1e-8
        for i in test_idx:
            s = float(X[i] @ c_dome - X[i] @ c_flat)  # >0 => dome-like
            scores.append(s); labels.append(int(y[i]))
    scores = np.array(scores); labels = np.array(labels)

    # ROC-AUC (rank-based) + best-threshold balanced accuracy
    order = np.argsort(-scores)
    P, N = labels.sum(), (labels == 0).sum()
    tp = fp = 0; auc = 0.0; prev_fpr = 0.0
    best_bal, best_thr = 0.0, 0.0
    tpr_at = {}
    for idx in order:
        if labels[idx] == 1:
            tp += 1
        else:
            fp += 1
        tpr, fpr = tp / P, fp / N
        auc += (fpr - prev_fpr) * tpr; prev_fpr = fpr
        bal = 0.5 * (tpr + (1 - fpr))
        if bal > best_bal:
            best_bal, best_thr = bal, scores[idx]
    pred = (scores >= best_thr).astype(int)
    dome_recall = (pred[labels == 1] == 1).mean()
    flat_spec = (pred[labels == 0] == 0).mean()
    print("=== Waymo-dome vs Wayve/flat separability (JamCam ~50px, leave-dome-source-out CV) ===")
    print(f"dome sources: {len(dome_sources)} (x{len(augment(np.zeros((4,4,3),np.uint8)))} augments) | "
          f"flat crops: {int(N)}")
    print(f"ROC-AUC:            {auc:.3f}")
    print(f"balanced accuracy:  {best_bal*100:.1f}%   (>=90% target)")
    print(f"  dome recall:      {dome_recall*100:.1f}%   (Waymos correctly flagged)")
    print(f"  flat specificity: {flat_spec*100:.1f}%   (Wayve/ordinary correctly NOT flagged)")
    print(f"VERDICT: {'PASS — >=90%, Wayve is cleanly separable' if best_bal>=0.90 else 'BELOW 90% — reconsider'}")


if __name__ == "__main__":
    main()
