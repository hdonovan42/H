#!/usr/bin/env python3
"""Auto-extract roof-dome crops from Waymo source images.

For each source image: detect the largest car (yolo11n), crop the roof band (the
top-centre region where the lidar dome sits). No manual per-image coordinates — the
human prunes misses from the contact sheet afterwards. Output feeds make_synthetic.py's
DOMES_DIR so the copy-paste engine pastes varied real domes onto London backplates.
"""
import glob
import os

import cv2
import numpy as np
from ultralytics import YOLO

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE, "data", "sources", "waymo")
OUT = os.path.join(BASE, "data", "sources", "domes")
MIN_CAR_FRAC = 0.03   # skip distant/incidental cars (bbox area < 3% of image)


def main():
    os.makedirs(OUT, exist_ok=True)
    for f in glob.glob(os.path.join(OUT, "*.jpg")):
        os.remove(f)
    det = YOLO("yolo11n.pt")
    imgs = sorted(f for ext in ("*.jpg", "*.jpeg", "*.png") for f in glob.glob(os.path.join(SRC, ext)))
    cells, n = [], 0
    for fp in imgs:
        im = cv2.imread(fp)
        if im is None:
            continue
        H, W = im.shape[:2]
        r = det.predict(im, conf=0.35, verbose=False)[0]
        cars = [b.xyxy[0].tolist() for b in r.boxes if int(b.cls[0]) == 2]
        if not cars:
            continue
        x1, y1, x2, y2 = map(int, max(cars, key=lambda b: (b[2] - b[0]) * (b[3] - b[1])))
        vw, vh = x2 - x1, y2 - y1
        if vw * vh < MIN_CAR_FRAC * W * H:
            continue  # too small to hold a usable dome
        mx = int(vw * 0.16)
        rx1, rx2 = max(0, x1 + mx), min(W, x2 - mx)
        ry1, ry2 = max(0, int(y1 - vh * 0.06)), min(H, int(y1 + vh * 0.45))
        crop = im[ry1:ry2, rx1:rx2]
        if crop.size == 0 or crop.shape[0] < 8 or crop.shape[1] < 8:
            continue
        cv2.imwrite(os.path.join(OUT, f"dome_{n:02d}.jpg"), crop)
        cell = cv2.resize(crop, (200, 150))
        cv2.rectangle(cell, (0, 0), (34, 22), (0, 0, 0), -1)
        cv2.putText(cell, str(n), (4, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
        cells.append(cell)
        n += 1
    print(f"extracted {n} dome candidates -> {OUT}")
    if cells:
        cols = 4
        while len(cells) % cols:
            cells.append(np.full((150, 200, 3), 35, np.uint8))
        rows = [np.hstack(cells[i:i + cols]) for i in range(0, len(cells), cols)]
        sheet = np.vstack(rows)
        out = os.path.join(BASE, "data/sources/dome_candidates.jpg")
        cv2.imwrite(out, sheet)
        print(f"contact sheet -> {out} {sheet.shape}")


if __name__ == "__main__":
    main()
