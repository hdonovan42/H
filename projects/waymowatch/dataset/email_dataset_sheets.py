#!/usr/bin/env python3
"""Email the operator labelled contact sheets of EVERY layer of the WaymoNet dataset,
for a specificity audit — 'is this data actually good enough to find a Waymo?'

Sheets (built into data/dataset_review/, then emailed via Resend):
  01 dome templates       — the 39 real dome crops the centroid/synthetics are built from
  02 wayve bars           — the 14 Wayve sensor-bar crops (the London confuser)
  03 waymo source photos  — provenance: the full photos the domes were harvested from
  04 synthetic positives  — dome pasted on real white JamCam hosts (what training sees),
                            cropped to the host vehicle, labelled with host height (px)
  05 scorer view (pairs)  — THE decisive sheet: the tight roof crop after JamCam degrade
                            (50px wide), upscaled 6x nearest — literally the embedder's
                            input — pasted (P) vs unpasted (U), live score stamped on each
  06 hard negatives       — banked real white cars that fooled the old surfacer

Run:  .venv/bin/python dataset/email_dataset_sheets.py [--no-send]
"""
import argparse
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

from separability_eval import build_embedder, jamcam                       # noqa: E402
from make_synthetic import _alpha_for, synth_one                           # noqa: E402
from live_capture import is_white, iou, roof_crop, load_centroid, MIN_H    # noqa: E402

MANIFEST = os.path.join(BASE, "data", "synthetic", "manifest.json")
OUT = os.path.join(BASE, "data", "dataset_review")
SEED = 1234


def fit(im, w, h, upscale_nearest=False):
    """Letterbox `im` into a (h, w) cell on dark grey."""
    cell = np.full((h, w, 3), 28, np.uint8)
    s = min(w / im.shape[1], h / im.shape[0])
    nw, nh = max(1, int(im.shape[1] * s)), max(1, int(im.shape[0] * s))
    interp = cv2.INTER_NEAREST if upscale_nearest and s > 1 else cv2.INTER_AREA
    r = cv2.resize(im, (nw, nh), interpolation=interp)
    x0, y0 = (w - nw) // 2, (h - nh) // 2
    cell[y0:y0 + nh, x0:x0 + nw] = r
    return cell


def label(cell, text):
    cv2.rectangle(cell, (0, 0), (7 + 8 * len(text), 16), (0, 0, 0), -1)
    cv2.putText(cell, text, (3, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 255, 255), 1)
    return cell


def grid(cells, cols, path):
    if not cells:
        return 0
    h, w = cells[0].shape[:2]
    cells = cells + [np.full((h, w, 3), 28, np.uint8)] * ((-len(cells)) % cols)
    g = np.vstack([np.hstack(cells[i:i + cols]) for i in range(0, len(cells), cols)])
    cv2.imwrite(path, g, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return len(cells)


def template_sheet(pattern, path, cols=8, cw=140, ch=110):
    files = sorted(glob.glob(pattern))
    cells = [label(fit(cv2.imread(f), cw, ch, upscale_nearest=True), os.path.basename(f)[:16])
             for f in files if cv2.imread(f) is not None]
    grid(cells, cols, path)
    return len(cells)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-send", action="store_true")
    a = ap.parse_args()
    random.seed(SEED)
    os.makedirs(OUT, exist_ok=True)
    sheets = []

    n1 = template_sheet(os.path.join(BASE, "data/sources/domes/*.jpg"),
                        os.path.join(OUT, "01_dome_templates.jpg"))
    n2 = template_sheet(os.path.join(BASE, "data/sources/wayve_rack/*.jpg"),
                        os.path.join(OUT, "02_wayve_bars.jpg"))
    n3 = template_sheet(os.path.join(BASE, "data/sources/waymo/*.jpg"),
                        os.path.join(OUT, "03_waymo_sources.jpg"), cols=5, cw=240, ch=180)
    sheets += [os.path.join(OUT, f) for f in
               ("01_dome_templates.jpg", "02_wayve_bars.jpg", "03_waymo_sources.jpg")]
    print(f"templates: {n1} domes, {n2} bars, {n3} sources")

    # synthetic positives + scorer-view pairs, from white hosts (the live-relevant subset)
    from ultralytics import YOLO
    det = YOLO(os.path.join(BASE, "yolo11n.pt"))
    embed = build_embedder()
    cen = load_centroid()
    domes = [(cv2.imread(f), _alpha_for(cv2.imread(f)))
             for f in sorted(glob.glob(os.path.join(BASE, "data/sources/domes/*.jpg")))]

    manifest = json.load(open(MANIFEST))
    random.shuffle(manifest)
    host_cells, pair_cells = [], []
    k = 0
    for m in manifest:
        if len(host_cells) >= 48 and len(pair_cells) >= 48:
            break
        img = cv2.imread(os.path.join(BASE, m["source_frame"]))
        if img is None:
            continue
        x1, y1, x2, y2 = host = tuple(m["host_bbox_xyxy"])
        if not is_white(img[max(0, y1):y2, max(0, x1):x2]):
            continue
        syn = synth_one(img, [host], domes, dome_pair=domes[k % len(domes)])
        k += 1
        if not syn:
            continue
        comp = syn[0]
        if len(host_cells) < 48:
            pad = 8
            crop = comp[max(0, y1 - pad):y2 + pad, max(0, x1 - pad):x2 + pad]
            host_cells.append(label(fit(crop, 170, 150, upscale_nearest=True), f"h={y2 - y1}px"))
        if len(pair_cells) < 48:
            r = det.predict(comp, conf=0.30, verbose=False, imgsz=352)[0]
            boxes = [tuple(map(int, b.xyxy[0].tolist())) for b in r.boxes if int(b.cls[0]) == 2]
            mt = [b for b in boxes if iou(b, host) > 0.40 and (b[3] - b[1]) >= MIN_H]
            if not mt:
                continue
            bb = max(mt, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
            for src, tag in ((comp, "P"), (img, "U")):
                rc = roof_crop(src, bb)
                if rc.size == 0 or min(rc.shape[:2]) < 4:
                    break
                seen = jamcam(rc)                       # exactly the embedder's input
                s = float(embed(seen) @ cen)
                pair_cells.append(label(fit(seen, 180, 80, upscale_nearest=True), f"{tag} {s:.2f}"))
    p4, p5 = os.path.join(OUT, "04_synthetic_positives.jpg"), os.path.join(OUT, "05_scorer_view_pairs.jpg")
    grid(host_cells, 6, p4)
    grid(pair_cells, 6, p5)   # P/U side by side per row triplet
    sheets += [p4, p5]
    print(f"synthetic hosts: {len(host_cells)} | scorer-view cells: {len(pair_cells)}")

    negs = sorted(glob.glob(os.path.join(BASE, "data/stage2/negatives/*.jpg")))
    random.shuffle(negs)
    p6 = os.path.join(OUT, "06_hard_negatives.jpg")
    grid([label(fit(cv2.imread(f), 170, 150), os.path.basename(f)[:14])
          for f in negs[:36] if cv2.imread(f) is not None], 6, p6)
    sheets.append(p6)

    if a.no_send:
        print("built (not sent):", *sheets, sep="\n  ")
        return
    from email_alert import send_email
    html = (
        "<p><b>WaymoWatch — dataset audit</b> (your request: are the images specific enough?)</p>"
        "<ol>"
        "<li><b>01 dome templates</b> — all 39 real dome crops the scorer/synthetics are seeded from.</li>"
        "<li><b>02 wayve bars</b> — the 14 Wayve sensor-bar crops (the confuser we must NOT match).</li>"
        "<li><b>03 waymo sources</b> — full photos the domes were harvested from (provenance).</li>"
        "<li><b>04 synthetic positives</b> — real dome pasted on real white JamCam cars, at true "
        "JamCam scale (h = host height in px; dome only resolvable &ge;44px).</li>"
        "<li><b>05 scorer view</b> — the decisive one: the tight roof crop after JamCam degradation, "
        "upscaled 6&times; — <i>this is literally all the model sees</i>. P = dome pasted, "
        "U = same car unpasted, number = live score (bar: digest 0.83, instant 0.88).</li>"
        "<li><b>06 hard negatives</b> — real white cars that fooled the old surfacer.</li>"
        "</ol>"
        "<p>Judge sheet 05 hardest: if YOU can't tell P from U at that resolution, "
        "neither can any model — that's the JamCam information floor.</p>")
    send_email("WaymoWatch: dataset audit — 6 contact sheets", html, attachments=sheets)


if __name__ == "__main__":
    main()
