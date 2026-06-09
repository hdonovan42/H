#!/usr/bin/env python3
"""Synthetic-positive generator for WaymoNet.

Real in-feed Waymos are too rare to wait for, so we manufacture training positives:
detect real vehicles in real London JamCam backplates, paste a real Waymo roof-dome
onto resolvable-size roofs, brightness-match + feather, re-degrade to the JamCam JPEG
domain, and emit a YOLO label (class 0 = waymo, box = the host vehicle).

Only vehicles >= MIN_H px tall are used (dome only resolvable near/mid field, the 45px
finding). Each synthetic records its SOURCE frame + camera in a manifest so the dataset
builder can do an honest by-camera split and emit matched (un-dome'd) negatives.

Dome templates are loaded from DOMES_DIR (drop harvested dome crops there); if empty,
falls back to the one curated crop from the Miami reference image.
"""
import glob
import json
import os
import random
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from copy_paste import composite, feathered_alpha, jamcam_degrade  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAMES = os.path.join(BASE, "data", "frames")
OUT_IMG = os.path.join(BASE, "data", "synthetic", "images")
OUT_LBL = os.path.join(BASE, "data", "synthetic", "labels")
MANIFEST = os.path.join(BASE, "data", "synthetic", "manifest.json")
DOMES_DIR = os.path.join(BASE, "data", "sources", "domes")  # harvested dome crops go here
DOME_FALLBACK_SRC = os.path.join(BASE, "data/sources/waymo/05_Waymo_Driverless_Vehicle_Brickell_Miami_April_.jpg")
DOME_FALLBACK_BBOX = (553, 150, 685, 245)
MIN_H = 44          # min host-vehicle bbox height (px) — dome only resolvable near/mid field
MAX_AR = 1.9        # max width/height — excludes long buses/lorries; Waymos are cars
VEHICLE_CLS = {2}   # COCO car only (Waymo = car-sized Jaguar I-PACE)
MAX_POS = 400
SEED = 1234


def _alpha_for(dome):
    """Feathered alpha biased to the dark dome pixels (works for a tightly-cropped dome)."""
    h, w = dome.shape[:2]
    alpha = feathered_alpha(h, w, feather=0.16)
    gray = cv2.cvtColor(dome, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    darkness = np.clip(1.0 - gray * 1.1, 0, 1)
    return np.clip(alpha * darkness ** 1.4, 0, 1)


def load_domes():
    """List of (dome_bgr, alpha). Prefer harvested crops in DOMES_DIR; else the curated fallback."""
    domes = []
    files = sorted(f for ext in ("*.jpg", "*.jpeg", "*.png") for f in glob.glob(os.path.join(DOMES_DIR, ext)))
    for f in files:
        im = cv2.imread(f)
        if im is not None:
            domes.append((im, _alpha_for(im)))
    if not domes:
        src = cv2.imread(DOME_FALLBACK_SRC)
        x1, y1, x2, y2 = DOME_FALLBACK_BBOX
        d = src[y1:y2, x1:x2]
        domes.append((d, _alpha_for(d)))
    return domes


def camera_of(frame_path):
    """data/frames/<short_id>/<clip_id>/fNNNN.jpg -> <short_id>."""
    return os.path.basename(os.path.dirname(os.path.dirname(frame_path)))


def synth_one(frame, boxes, domes, dome_pair=None):
    """Paste a dome on the largest resolvable car; return (img, yolo_line, bbox) or None.
    `dome_pair` pins the (dome, alpha) template (recall_eval's leave-one-out); default random."""
    cand = [b for b in boxes if (b[3] - b[1]) >= MIN_H
            and (b[2] - b[0]) / max(1, b[3] - b[1]) <= MAX_AR]
    if not cand:
        return None
    x1, y1, x2, y2 = max(cand, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
    vw, vh = x2 - x1, y2 - y1
    dome, dome_a = dome_pair if dome_pair is not None else random.choice(domes)
    target_w = max(8, int(vw * 0.34))
    scale = target_w / dome.shape[1]
    cx = x1 + vw * 0.5 + random.uniform(-0.05, 0.05) * vw
    cy = y1 + dome.shape[0] * scale * 0.45 + vh * 0.04  # sit just on the roofline
    out, box = composite(frame, dome, cx, cy, scale, alpha=dome_a, brightness_match=True)
    if box is None:
        return None
    out = jamcam_degrade(out, jpeg_q=random.randint(32, 46))
    H, W = out.shape[:2]
    cxn, cyn = (x1 + x2) / 2 / W, (y1 + y2) / 2 / H
    wn, hn = vw / W, vh / H
    return out, f"0 {cxn:.6f} {cyn:.6f} {wn:.6f} {hn:.6f}", (x1, y1, x2, y2)


def main():
    random.seed(SEED)
    os.makedirs(OUT_IMG, exist_ok=True)
    os.makedirs(OUT_LBL, exist_ok=True)
    from ultralytics import YOLO
    det = YOLO("yolo11n.pt")
    domes = load_domes()
    print(f"dome templates: {len(domes)} ({'harvested' if os.path.isdir(DOMES_DIR) and os.listdir(DOMES_DIR) else 'fallback'})")
    frames = sorted(glob.glob(os.path.join(FRAMES, "**", "*.jpg"), recursive=True))
    random.shuffle(frames)
    made, crops, manifest = 0, [], []
    for fp in frames:
        if made >= MAX_POS:
            break
        img = cv2.imread(fp)
        if img is None:
            continue
        r = det.predict(img, conf=0.30, verbose=False, imgsz=352)[0]
        boxes = [tuple(map(int, b.xyxy[0].tolist())) for b in r.boxes if int(b.cls[0]) in VEHICLE_CLS]
        res = synth_one(img, boxes, domes)
        if not res:
            continue
        out, line, (x1, y1, x2, y2) = res
        name = f"syn_{made:03d}"
        cv2.imwrite(os.path.join(OUT_IMG, name + ".jpg"), out)
        open(os.path.join(OUT_LBL, name + ".txt"), "w").write(line + "\n")
        manifest.append({
            "name": name,
            "source_frame": os.path.relpath(fp, BASE),
            "camera": camera_of(fp),
            "host_bbox_xyxy": [x1, y1, x2, y2],
        })
        pad = 6
        crop = out[max(0, y1 - pad):y2 + pad, max(0, x1 - pad):x2 + pad]
        if crop.size:
            crops.append(cv2.resize(crop, (160, 160), interpolation=cv2.INTER_NEAREST))
        made += 1
    json.dump(manifest, open(MANIFEST, "w"), indent=2)
    cams = sorted({m["camera"] for m in manifest})
    print(f"generated {made} synthetic positives -> {OUT_IMG}")
    print(f"manifest -> {MANIFEST} | source cameras: {len(cams)} {cams}")
    if crops:
        cols = 6
        while len(crops) % cols:
            crops.append(np.full((160, 160, 3), 35, np.uint8))
        rows = [np.hstack(crops[i:i + cols]) for i in range(0, len(crops), cols)]
        sheet = np.vstack(rows)
        out = os.path.join(BASE, "data/synthetic/synthetic_contact_sheet.jpg")
        cv2.imwrite(out, sheet)
        print(f"contact sheet -> {out} {sheet.shape}")


if __name__ == "__main__":
    main()
