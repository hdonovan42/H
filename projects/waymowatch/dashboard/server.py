#!/usr/bin/env python3
"""WaymoNet inference dashboard — read-only browse + on-demand inference + upload.

Tailnet-only (fronted by `tailscale serve`); no auth of its own. Serves the SPA at `/` and a small
JSON API. Runs `best.pt` via ultralytics on CPU, one inference at a time (the VPS is 2-vCPU and
shares it with the live loop). Returns every box >= BASE_CONF; the UI slider filters live, so moving
the threshold never re-runs inference.

Env:
  WAYMONET_WEIGHTS  path to best.pt          (default: ./best.pt)
  WAYMONET_DB       path to waymo.db         (default: ../data/waymo.db; optional)
  WAYMONET_SPECIAL  special galleries dir    (default: ../data/special; optional)
  WAYMONET_BROWSE   local-mode root: each immediate subdir becomes an explorer group (optional)
"""
import glob
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEIGHTS = os.environ.get("WAYMONET_WEIGHTS", os.path.join(HERE, "best.pt"))
DB = os.environ.get("WAYMONET_DB", os.path.join(ROOT, "data", "waymo.db"))
SPECIAL = os.environ.get("WAYMONET_SPECIAL", os.path.join(ROOT, "data", "special"))
BROWSE = os.environ.get("WAYMONET_BROWSE", "")   # local mode: each immediate subdir -> a group
HOST = os.environ.get("WAYMONET_HOST", "127.0.0.1")  # set 0.0.0.0 on the homebox (tailnet-reachable)
PORT = int(os.environ.get("WAYMONET_PORT", "3105"))
IMGSZ = 704
BASE_CONF = 0.03            # return everything >= this; UI slider filters above it
MAX_UPLOAD = 8 * 1024 * 1024

_model = None
_lock = threading.Lock()


def model():
    global _model
    if _model is None:
        from ultralytics import YOLO
        _model = YOLO(WEIGHTS)
    return _model


def _db_rows(where, limit=None):
    import sqlite3
    if not os.path.exists(DB):
        return []
    try:
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=60)
        q = (f"SELECT id, frame_path FROM candidates WHERE {where} AND frame_path IS NOT NULL "
             f"ORDER BY id DESC" + (f" LIMIT {int(limit)}" if limit else ""))
        rows = con.execute(q).fetchall()
        con.close()
        return rows
    except Exception:
        return []


def registry():
    """Build {id -> abspath} plus the explorer tree. Sources degrade gracefully if absent."""
    reg, tree = {}, []

    def add_group(name, pairs):              # pairs = [(id, path, label)]
        imgs = []
        for iid, p, label in pairs:
            if p and os.path.exists(p):
                reg[iid] = p
                imgs.append({"id": iid, "label": label})
        if imgs:
            tree.append({"name": name, "count": len(imgs), "images": imgs})

    add_group("Confirmed Waymos",
              [(f"db{r[0]}", r[1], f"#{r[0]}") for r in _db_rows("status='waymo'")])
    for d in sorted(glob.glob(os.path.join(SPECIAL, "*/"))):
        gname = os.path.basename(d.rstrip("/"))
        add_group(f"Gallery: {gname}",
                  [("sp_" + gname + "_" + os.path.basename(f)[:-10], f, os.path.basename(f)[:14])
                   for f in sorted(glob.glob(d + "*_frame.jpg"))])
    add_group("Recent candidates",
              [(f"db{r[0]}", r[1], f"#{r[0]}") for r in _db_rows("status='new'", limit=60)])
    if BROWSE:               # local mode: list each subdir of BROWSE as its own group (no DB needed)
        for d in sorted(glob.glob(os.path.join(BROWSE, "*/"))):
            gname = os.path.basename(d.rstrip("/"))
            add_group(gname.replace("_", " "),
                      [("br_" + gname + "_" + os.path.basename(f)[:-4], f, os.path.basename(f)[:16])
                       for f in sorted(glob.glob(d + "*.jpg"))])
    return reg, tree


def infer(img):
    """Run WaymoNet on a BGR ndarray; return {w,h,time_ms,boxes:[{x1,y1,x2,y2,conf}]} (>=BASE_CONF)."""
    with _lock:
        t = time.time()
        r = model().predict(img, conf=BASE_CONF, imgsz=IMGSZ, verbose=False)[0]
        dt = (time.time() - t) * 1000
    h, w = img.shape[:2]
    boxes = [{"x1": round(float(b.xyxy[0][0]), 1), "y1": round(float(b.xyxy[0][1]), 1),
              "x2": round(float(b.xyxy[0][2]), 1), "y2": round(float(b.xyxy[0][3]), 1),
              "conf": round(float(b.conf[0]), 3)} for b in r.boxes]
    boxes.sort(key=lambda b: -b["conf"])
    return {"w": w, "h": h, "time_ms": round(dt), "boxes": boxes}


class Handler(BaseHTTPRequestHandler):
    server_version = "waymonet-dash"

    def log_message(self, *a):
        pass

    def _send(self, code, ctype, body, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, "application/json", json.dumps(obj).encode())

    def do_GET(self):
        path = urlparse(self.path).path
        qs = parse_qs(urlparse(self.path).query)
        if path in ("/", "/index.html"):
            try:
                self._send(200, "text/html; charset=utf-8",
                           open(os.path.join(HERE, "index.html"), "rb").read())
            except FileNotFoundError:
                self._json({"error": "index.html missing"}, 404)
            return
        if path == "/api/tree":
            self._json({"tree": registry()[1]})
            return
        if path == "/img":
            p = registry()[0].get(qs.get("id", [""])[0])
            if p:
                self._send(200, "image/jpeg", open(p, "rb").read(), "public, max-age=3600")
            else:
                self._json({"error": "not found"}, 404)
            return
        if path == "/api/infer":
            p = registry()[0].get(qs.get("id", [""])[0])
            if not p:
                self._json({"error": "unknown id"}, 404)
                return
            img = cv2.imread(p)
            if img is None:
                self._json({"error": "unreadable"}, 400)
                return
            self._json(infer(img))
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        if urlparse(self.path).path != "/api/infer":
            self._json({"error": "not found"}, 404)
            return
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > MAX_UPLOAD:
            self._json({"error": f"bad upload size (max {MAX_UPLOAD} bytes)"}, 400)
            return
        raw = self.rfile.read(n)
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            self._json({"error": "not a decodable image"}, 400)
            return
        self._json(infer(img))


if __name__ == "__main__":
    print(f"waymonet-dash {HOST}:{PORT} | weights={WEIGHTS} | db={'yes' if os.path.exists(DB) else 'no'}",
          flush=True)
    model()  # warm the model at startup so the first request isn't slow
    print("model warm — serving", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
