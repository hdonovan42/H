#!/usr/bin/env python3
"""Generic Bing image crawl -> contact sheet (personal-use only; we filter visually).

Usage: crawl_images.py --out <dir> --queries "q1;q2;..." [--max 25] [--sheet path]
"""
import argparse
import glob
import logging
import os

import cv2
import numpy as np
from icrawler.builtin import BingImageCrawler

logging.getLogger("icrawler").setLevel(logging.ERROR)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--queries", required=True, help="semicolon-separated")
    ap.add_argument("--max", type=int, default=25)
    ap.add_argument("--sheet", default=None)
    args = ap.parse_args()
    queries = [q.strip() for q in args.queries.split(";") if q.strip()]
    for i, q in enumerate(queries):
        d = os.path.join(args.out, str(i))
        os.makedirs(d, exist_ok=True)
        BingImageCrawler(storage={"root_dir": d}, log_level=logging.ERROR).crawl(
            keyword=q, max_num=args.max, filters={"type": "photo"})
    files = sorted(f for ext in ("*.jpg", "*.jpeg", "*.png")
                   for f in glob.glob(os.path.join(args.out, "**", ext), recursive=True))
    kept = []
    cells = []
    for f in files:
        im = cv2.imread(f)
        if im is None or min(im.shape[:2]) < 60:
            continue
        h, w = im.shape[:2]
        im = cv2.resize(im, (190, max(1, int(h * 190 / w))))
        canvas = np.full((150, 190, 3), 35, np.uint8)
        canvas[:min(150, im.shape[0])] = im[:150]
        cv2.rectangle(canvas, (0, 0), (40, 20), (0, 0, 0), -1)
        cv2.putText(canvas, str(len(kept)), (3, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2)
        cells.append(canvas); kept.append(f)
    if args.sheet and cells:
        cols = 6
        cells += [np.full((150, 190, 3), 35, np.uint8)] * ((-len(cells)) % cols)
        rows = [np.hstack(cells[i:i + cols]) for i in range(0, len(cells), cols)]
        cv2.imwrite(args.sheet, np.vstack(rows))
    import json
    json.dump(kept, open(os.path.join(args.out, "index.json"), "w"))
    print(f"downloaded {len(kept)} usable images -> {args.out}; sheet -> {args.sheet}")


if __name__ == "__main__":
    main()
