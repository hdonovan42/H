#!/usr/bin/env python3
"""Fetch CC/PD-licensed Waymo (and Jaguar I-PACE) imagery from Wikimedia Commons,
record per-image licence/attribution to a manifest, and build a labelled contact
sheet so we can pick clean roof-dome crops for the copy-paste synthetic-positive engine.

Wikimedia Commons images are reusable (CC/PD) with attribution — safe to train a
shippable model on, unlike the Waymo Open Dataset / Getty.
"""
import glob
import json
import os
import re
import urllib.parse
import urllib.request

import cv2
import numpy as np

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "data", "sources", "waymo")
API = "https://commons.wikimedia.org/w/api.php"
UA = "WaymoWatch/0.1 (autonomous-vehicle spotting research; https://hjd.ai)"
CATEGORIES = ["Category:Waymo", "Category:Waymo vehicles", "Category:Jaguar I-Pace"]
MAX_IMAGES = 28


def api(params):
    params = {**params, "format": "json"}
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.load(r)


def strip_html(s):
    return re.sub(r"<[^>]+>", "", s or "").strip()


def gather():
    manifest, seen = [], set()
    for cat in CATEGORIES:
        try:
            data = api({"action": "query", "generator": "categorymembers",
                        "gcmtitle": cat, "gcmtype": "file", "gcmlimit": "40",
                        "prop": "imageinfo", "iiprop": "url|mime|extmetadata",
                        "iiurlwidth": "1024"})
        except Exception as e:
            print(f"  category {cat}: ERROR {e}")
            continue
        for page in data.get("query", {}).get("pages", {}).values():
            ii = (page.get("imageinfo") or [{}])[0]
            if not ii.get("mime", "").startswith("image/"):
                continue
            title = page["title"]
            if title in seen:
                continue
            seen.add(title)
            em = ii.get("extmetadata", {})
            manifest.append({
                "title": title,
                "url": ii.get("thumburl") or ii.get("url"),
                "license": strip_html(em.get("LicenseShortName", {}).get("value", "?")),
                "artist": strip_html(em.get("Artist", {}).get("value", "?"))[:80],
                "descurl": ii.get("descriptionurl"),
                "category": cat,
            })
    return manifest[:MAX_IMAGES]


def download(manifest):
    os.makedirs(OUT, exist_ok=True)
    ok = 0
    for i, m in enumerate(manifest):
        if not m["url"]:
            continue
        ext = os.path.splitext(urllib.parse.urlparse(m["url"]).path)[1].lower() or ".jpg"
        if ext not in (".jpg", ".jpeg", ".png", ".webp"):
            ext = ".jpg"
        safe = re.sub(r"[^A-Za-z0-9]+", "_", m["title"].replace("File:", ""))[:46]
        fp = os.path.join(OUT, f"{i:02d}_{safe}{ext}")
        try:
            req = urllib.request.Request(m["url"], headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r, open(fp, "wb") as f:
                f.write(r.read())
            m["path"], m["idx"] = fp, i
            ok += 1
        except Exception as e:
            m["error"] = str(e)
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=2)
    return ok


def contact_sheet(cols=4, cell=260):
    files = sorted(f for ext in ("*.jpg", "*.jpeg", "*.png", "*.webp")
                   for f in glob.glob(os.path.join(OUT, ext)))
    cells = []
    for f in files:
        im = cv2.imread(f)
        if im is None:
            continue
        h, w = im.shape[:2]
        im = cv2.resize(im, (cell, max(1, int(h * cell / w))))
        canvas = np.full((cell, cell, 3), 35, np.uint8)
        hh = min(im.shape[0], cell)
        canvas[:hh] = im[:hh]
        tag = os.path.basename(f).split("_")[0]
        cv2.rectangle(canvas, (0, 0), (40, 24), (0, 0, 0), -1)
        cv2.putText(canvas, tag, (4, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
        cells.append((tag, f, canvas))
    if not cells:
        print("no images to montage")
        return
    rows = []
    for r in range(0, len(cells), cols):
        row = [c[2] for c in cells[r:r + cols]]
        while len(row) < cols:
            row.append(np.full((cell, cell, 3), 35, np.uint8))
        rows.append(np.hstack(row))
    sheet = np.vstack(rows)
    out = os.path.join(BASE, "data", "sources", "waymo_contact_sheet.jpg")
    cv2.imwrite(out, sheet)
    print(f"contact sheet: {out}  ({sheet.shape[1]}x{sheet.shape[0]}, {len(cells)} imgs)")
    print("index -> file | licence:")
    man = {m.get("idx"): m for m in json.load(open(os.path.join(OUT, "manifest.json")))}
    for tag, f, _ in cells:
        m = man.get(int(tag), {})
        print(f"  {tag}  {os.path.basename(f)[:40]:<40} {m.get('license','?')}")


if __name__ == "__main__":
    man = gather()
    n = download(man)
    print(f"downloaded {n}/{len(man)} images to {OUT}")
    contact_sheet()
