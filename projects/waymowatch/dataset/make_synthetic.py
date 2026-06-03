#!/usr/bin/env python3
"""Synthetic-positive generator for WaymoNet.

Real in-feed Waymos are too rare to wait for, so we manufacture training positives:
detect real vehicles in real London JamCam backplates, paste a real Waymo roof-dome
onto resolvable-size roofs, brightness-match + feather, re-degrade to the JamCam JPEG
domain, and emit a YOLO label (class 0 = waymo, box = the host vehicle).

Only vehicles >= MIN_H px tall are used, because the dome is only resolvable when the
car is near/mid field (the 45px finding from dome_scale_test).
"""
import glob
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
DOME_SRC = os.path.join(BASE, "data/sources/waymo/05_Waymo_Driverless_Vehicle_Brickell_Miami_April_.jpg")
DOME_BBOX = (553, 150, 685, 245)  # (x1,y1,x2,y2) the lidar dome+mount in the source
MIN_H = 30          # min host-vehicle bbox height (px) — dome must be resolvable
MAX_AR = 1.9        # max width/height — excludes long buses/lorries; Waymos are cars
VEHICLE_CLS = {2}   # COCO car only (Waymo = car-sized Jaguar I-PACE, not bus/lorry)
MAX_POS = 80
SEED = 1234


def load_dome():
    src = cv2.imread(DOME_SRC)
    x1, y1, x2, y2 = DOME_BBOX
    dome = src[y1:y2, x1:x2]
    h, w = dome.shape[:2]
    # alpha: keep the central dome, fade edges; bias toward the darker dome pixels
    alpha = feathered_alpha(h, w, feather=0.16)
    gray = cv2.cvtColor(dome, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    darkness = np.clip(1.0 - gray * 1.1, 0, 1)  # dome is dark vs bright sky/roof
    alpha = np.clip(alpha * darkness ** 1.4, 0, 1)  # concentrate on the dark dome, less boxy
    return dome, alpha


def synth_one(frame, boxes, dome, dome_a):
    """Paste a dome on the largest resolvable vehicle; return (img, yolo_line) or None."""
    cand = [b for b in boxes if (b[3] - b[1]) >= MIN_H
            and (b[2] - b[0]) / max(1, b[3] - b[1]) <= MAX_AR]
    if not cand:
        return None
    x1, y1, x2, y2 = max(cand, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
    vw, vh = x2 - x1, y2 - y1
    # dome width ~ 0.34 of car width; place at roof (top-centre of the vehicle box)
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
    dome, dome_a = load_dome()
    frames = sorted(glob.glob(os.path.join(FRAMES, "**", "*.jpg"), recursive=True))
    random.shuffle(frames)
    made, crops = 0, []
    for fp in frames:
        if made >= MAX_POS:
            break
        img = cv2.imread(fp)
        if img is None:
            continue
        r = det.predict(img, conf=0.30, verbose=False, imgsz=352)[0]
        boxes = [tuple(map(int, b.xyxy[0].tolist())) for b in r.boxes
                 if int(b.cls[0]) in VEHICLE_CLS]
        res = synth_one(img, boxes, dome, dome_a)
        if not res:
            continue
        out, line, (x1, y1, x2, y2) = res
        name = f"syn_{made:03d}"
        cv2.imwrite(os.path.join(OUT_IMG, name + ".jpg"), out)
        open(os.path.join(OUT_LBL, name + ".txt"), "w").write(line + "\n")
        # zoomed crop of the host vehicle for the inspection sheet
        pad = 6
        crop = out[max(0, y1 - pad):y2 + pad, max(0, x1 - pad):x2 + pad]
        if crop.size:
            crops.append(cv2.resize(crop, (160, 160), interpolation=cv2.INTER_NEAREST))
        made += 1
    print(f"generated {made} synthetic positives -> {OUT_IMG}")
    # contact sheet of the pasted vehicles (4x zoom)
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
