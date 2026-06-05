#!/usr/bin/env python3
"""Extract roof-band crops from a folder of vehicle images (generic).

Detect the largest car (yolo11n), crop the top-centre roof band where any roof sensor
sits. Used for both Waymo domes and Wayve roofs so the separability test compares
like-for-like crops. Human prunes misses from the contact sheet.

Usage: extract_roofs.py --src <dir> --out <dir> [--min-frac 0.03] [--tag roof]
"""
import argparse
import glob
import os

import cv2
import numpy as np
from ultralytics import YOLO


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-frac", type=float, default=0.03)
    ap.add_argument("--tag", default="roof")
    ap.add_argument("--sheet", default=None, help="contact-sheet output path")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    for f in glob.glob(os.path.join(args.out, "*.jpg")):
        os.remove(f)
    det = YOLO("yolo11n.pt")
    imgs = sorted(f for ext in ("*.jpg", "*.jpeg", "*.png")
                  for f in glob.glob(os.path.join(args.src, "**", ext), recursive=True))
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
        if vw * vh < args.min_frac * W * H:
            continue
        mx = int(vw * 0.16)
        rx1, rx2 = max(0, x1 + mx), min(W, x2 - mx)
        ry1, ry2 = max(0, int(y1 - vh * 0.06)), min(H, int(y1 + vh * 0.45))
        crop = im[ry1:ry2, rx1:rx2]
        if crop.size == 0 or min(crop.shape[:2]) < 8:
            continue
        cv2.imwrite(os.path.join(args.out, f"{args.tag}_{n:02d}.jpg"), crop)
        cell = cv2.resize(crop, (200, 150))
        cv2.rectangle(cell, (0, 0), (34, 22), (0, 0, 0), -1)
        cv2.putText(cell, str(n), (4, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
        cells.append(cell)
        n += 1
    print(f"extracted {n} {args.tag} crops -> {args.out}")
    if cells and args.sheet:
        cols = 4
        cells += [np.full((150, 200, 3), 35, np.uint8)] * ((-len(cells)) % cols)
        rows = [np.hstack(cells[i:i + cols]) for i in range(0, len(cells), cols)]
        cv2.imwrite(args.sheet, np.vstack(rows))
        print(f"contact sheet -> {args.sheet}")


if __name__ == "__main__":
    main()
