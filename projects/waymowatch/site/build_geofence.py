#!/usr/bin/env python3
"""Bake site/geofence.html — the geofence-estimate demo — from live data.

The demo is a frozen snapshot on purpose: it makes no API call at runtime, so it
stays readable if the feed moves and it costs one static file to serve. Re-run
this to refresh it, then `./deploy.sh`.

Two sources, because neither alone is enough:
  * sightings  — the public API (already deduped to distinct PASSES)
  * cameras    — waymo.db on the VPS, for the cameras that have NEVER seen a
                 Waymo. Those are the whole point: a footprint drawn from hits
                 alone can't be falsified, so we plot the negative space too.

Usage:  python3 build_geofence.py
"""

import json
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
INDEX = HERE / "index.html"
TEMPLATE = HERE / "geofence.tpl.html"
OUT = HERE / "geofence.html"

API = "https://waymonet.com/api/sightings"
VPS = "root@vps-hel1"
EPOCH = datetime(2026, 6, 1, tzinfo=timezone.utc)   # first sighting is 10 Jun 2026

# Kept in step with collector/live_capture.py: ZONE
ZONE = dict(lat0=51.42, lat1=51.58, lon0=-0.36, lon1=0.06)

CAMS_SQL = """
import sqlite3, json
c = sqlite3.connect("file:data/waymo.db?mode=ro", uri=True, timeout=30)
c.row_factory = sqlite3.Row
out = [dict(id=r["id"], name=r["common_name"], lat=round(r["lat"], 5),
            lon=round(r["lon"], 5), avail=int(r["available"] or 0))
       for r in c.execute("select id, common_name, lat, lon, available "
                          "from cameras where lat is not null")]
print(json.dumps(out))
"""


def fetch_sightings():
    req = urllib.request.Request(API, headers={"Accept-Encoding": "identity"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)["sightings"]


def fetch_cameras():
    out = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", VPS,
         "cd /home/hq/waymowatch && .venv/bin/python -"],
        input=CAMS_SQL, capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        sys.exit(f"camera fetch failed:\n{out.stderr}")
    return json.loads(out.stdout)


def leaflet_css():
    """Reuse the Leaflet CSS already inlined in index.html — one copy, one truth."""
    lines = INDEX.read_text().splitlines(True)
    start = next(i for i, l in enumerate(lines) if l.strip() == "<style>")
    end = next(i for i, l in enumerate(lines[start:], start) if l.strip() == "</style>")
    return "".join(lines[start + 1:end])


def carto_key():
    """Lift the basemap key out of index.html so it is only ever written down once."""
    m = re.search(r"cartocdn\.com/light_all/[^\"']*?[?&]key=([A-Za-z0-9_]+)", INDEX.read_text())
    if not m:
        sys.exit("no CARTO key found in index.html")
    return m.group(1)


def main():
    sightings = fetch_sightings()
    cameras = fetch_cameras()

    idx, cams = {}, []
    for c in cameras:
        in_zone = (ZONE["lat0"] <= c["lat"] <= ZONE["lat1"]
                   and ZONE["lon0"] <= c["lon"] <= ZONE["lon1"])
        idx[c["id"]] = len(cams)
        cams.append([c["lat"], c["lon"], int(in_zone), c["avail"], c["name"]])

    hits, orphans = [], 0
    for s in sightings:
        i = idx.get(s["camera_id"])
        if i is None:                     # camera TfL has since retired
            orphans += 1
            continue
        t = datetime.strptime(s["captured_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        hits.append([i, round((t - EPOCH).total_seconds() / 3600, 1), s["frames"]])
    hits.sort(key=lambda h: h[1])

    polled = sum(1 for c in cams if c[2] and c[3])
    payload = dict(
        epoch=EPOCH.strftime("%Y-%m-%dT%H:%M:%SZ"),
        generated=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        latest=max(s["captured_at"] for s in sightings),
        polled=polled, zone=ZONE, cams=cams, hits=hits,
    )

    html = (TEMPLATE.read_text()
            .replace("/*__LEAFLET_CSS__*/", leaflet_css())
            .replace("/*__PAYLOAD__*/", json.dumps(payload, separators=(",", ":")))
            .replace("__CARTO_KEY__", carto_key()))
    OUT.write_text(html)

    hit_cams = {h[0] for h in hits}
    print(f"passes {len(hits)} (orphaned {orphans}) · cameras {len(cams)} · "
          f"polled {polled} · hit {len(hit_cams & {i for i, c in enumerate(cams) if c[2] and c[3]})}")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
