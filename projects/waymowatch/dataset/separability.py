#!/usr/bin/env python3
"""Waymo-dome vs Wayve/ordinary-roof separability at JamCam scale (no GPU, no API).

Renders real roof crops at the pixel width a JamCam sees them, with JPEG degradation,
so we can judge BEFORE spending GPU time whether the dome is a usable discriminator.
Outputs two montages: a dome-vs-flat panel at ~50px and a scale-sweep (64->22px).
"""
import glob
import os
import random

import cv2
import numpy as np

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOMES = sorted(glob.glob(os.path.join(BASE, "data/sources/domes/*.jpg")))
FLATS = sorted(glob.glob(os.path.join(BASE, "data/sources/wayve_roofs/*.jpg")))
random.seed(1)


def jamcam(crop, wpx, q=38):
    h, w = crop.shape[:2]
    small = cv2.resize(crop, (wpx, max(1, int(h * wpx / w))), interpolation=cv2.INTER_AREA)
    enc = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, q])[1]
    return cv2.imdecode(enc, cv2.IMREAD_COLOR)


def tile(crop, wpx, zoom, cell_w, cell_h):
    sm = jamcam(crop, wpx)
    big = cv2.resize(sm, (wpx * zoom, sm.shape[0] * zoom), interpolation=cv2.INTER_NEAREST)
    t = np.full((cell_h, cell_w, 3), 30, np.uint8)
    hh, ww = min(big.shape[0], cell_h), min(big.shape[1], cell_w)
    t[:hh, :ww] = big[:hh, :ww]
    return t


def band(text, w, h=26, colour=(0, 230, 0)):
    b = np.full((h, w, 3), 0, np.uint8)
    cv2.putText(b, text, (6, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.6, colour, 2)
    return b


def panel(crops, label, wpx=50, zoom=5, cols=6):
    cw, ch = wpx * zoom, wpx * zoom // 2
    tiles = [tile(cv2.imread(f), wpx, zoom, cw, ch) for f in crops]
    tiles += [np.full((ch, cw, 3), 30, np.uint8)] * ((-len(tiles)) % cols)
    rows = [np.hstack([cv2.copyMakeBorder(t, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=(70, 70, 70))
                       for t in tiles[i:i + cols]]) for i in range(0, len(tiles), cols)]
    grid = np.vstack(rows)
    return np.vstack([band(label, grid.shape[1]), grid])


def main():
    dome = DOMES[:8]
    flat = random.sample(FLATS, min(12, len(FLATS)))
    a = panel(dome, "WAYMO  (roof DOME)  @ ~50px JamCam scale", cols=8)
    b = panel(flat, "WAYVE / ORDINARY  (flat roof)  @ ~50px JamCam scale", cols=6)
    w = max(a.shape[1], b.shape[1])
    pad = lambda im: cv2.copyMakeBorder(im, 8, 8, 0, w - im.shape[1], cv2.BORDER_CONSTANT, value=(30, 30, 30))
    cv2.imwrite(os.path.join(BASE, "data/sources/separability_dome_vs_flat.jpg"), np.vstack([pad(a), pad(b)]))

    # scale sweep: one dome, one flat, across widths
    widths = [72, 50, 34, 22]
    d, f = cv2.imread(dome[0]), cv2.imread(flat[0])
    CW, CH = 72 * 5, 72 * 5 // 2
    drow = [band(f"{wpx}px", CW)[:0] if False else np.vstack([band(f"{wpx}px", CW), tile(d, wpx, 5, CW, CH)]) for wpx in widths]
    frow = [tile(f, wpx, 5, CW, CH) for wpx in widths]
    top = np.hstack([cv2.copyMakeBorder(c, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=(70, 70, 70)) for c in drow])
    bot = np.hstack([cv2.copyMakeBorder(c, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=(70, 70, 70)) for c in frow])
    sweep = np.vstack([band("WAYMO dome at shrinking JamCam scale:", top.shape[1]), top,
                       band("WAYVE/ordinary flat roof, same scales:", bot.shape[1]), bot])
    cv2.imwrite(os.path.join(BASE, "data/sources/separability_scale_sweep.jpg"), sweep)
    print("wrote separability_dome_vs_flat.jpg and separability_scale_sweep.jpg")
    print(f"domes={len(dome)} flats sampled={len(flat)} of {len(FLATS)}")


if __name__ == "__main__":
    main()
