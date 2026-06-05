#!/usr/bin/env python3
"""Harvest Wayve (and Uber-on-Wayve) vehicle imagery via Bing image crawl.

Wayve is the #1 false-positive risk for WaymoNet (also white London I-PACEs, no dome).
Personal-scope only — mixed licence, do not redistribute. We filter the results visually
from the contact sheet (no API calls), then extract roof crops for the separability test.
"""
import glob
import logging
import os

import cv2
import numpy as np
from icrawler.builtin import BingImageCrawler

logging.getLogger("icrawler").setLevel(logging.ERROR)
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(BASE, "data", "sources", "wayve_raw")
QUERIES = [
    "Wayve self-driving car",
    "Wayve autonomous vehicle London street",
    "Wayve Ford Mustang Mach-E sensors roof",
    "Wayve AI driver car",
    "Wayve Jaguar I-Pace",
]


def crawl():
    for i, q in enumerate(QUERIES):
        d = os.path.join(RAW, str(i))
        os.makedirs(d, exist_ok=True)
        BingImageCrawler(storage={"root_dir": d}, log_level=logging.ERROR).crawl(
            keyword=q, max_num=25, filters={"type": "photo"})


def contact():
    files = sorted(f for ext in ("*.jpg", "*.jpeg", "*.png")
                   for f in glob.glob(os.path.join(RAW, "**", ext), recursive=True))
    cells, kept = [], []
    for f in files:
        im = cv2.imread(f)
        if im is None or min(im.shape[:2]) < 60:
            continue
        h, w = im.shape[:2]
        im = cv2.resize(im, (190, max(1, int(h * 190 / w))))
        canvas = np.full((150, 190, 3), 35, np.uint8)
        canvas[:min(150, im.shape[0])] = im[:150]
        cv2.rectangle(canvas, (0, 0), (34, 20), (0, 0, 0), -1)
        cv2.putText(canvas, str(len(kept)), (3, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2)
        cells.append(canvas)
        kept.append(f)
    cols = 6
    pad = cells + [np.full((150, 190, 3), 35, np.uint8)] * ((-len(cells)) % cols)
    rows = [np.hstack(pad[i:i + cols]) for i in range(0, len(pad), cols)]
    sheet = np.vstack(rows) if rows else np.zeros((150, 190, 3), np.uint8)
    out = os.path.join(BASE, "data/sources/wayve_candidates.jpg")
    cv2.imwrite(out, sheet)
    # index map for visual pruning
    import json
    json.dump(kept, open(os.path.join(RAW, "index.json"), "w"))
    print(f"downloaded {len(kept)} usable images; contact sheet -> {out} {sheet.shape}")


if __name__ == "__main__":
    crawl()
    contact()
