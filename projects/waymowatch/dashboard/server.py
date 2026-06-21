#!/usr/bin/env python3
"""WaymoNet dashboard — read-only browse VIEWER. No model in this process.

Decoupled from inference (2026-06-21): this serves the SPA at `/`, the gallery JSON API
(`/api/tree`, `/img`), and PROXIES `/api/infer` to the separate `waymonet-infer` service
(default 127.0.0.1:3105). The trained model lives ONLY in that service — so the detection
worker never depends on this viewer, and restarting/redeploying the viewer can never disturb
detection (the bug that motivated the split). Tailnet-only (fronted by VPS nginx); no auth.

Env:
  WAYMONET_INFER_URL inference service endpoint (default: http://127.0.0.1:3105/api/infer)
  WAYMONET_DB        path to waymo.db          (default: ../data/waymo.db; optional)
  WAYMONET_SPECIAL   special galleries dir     (default: ../data/special; optional)
  WAYMONET_BROWSE    local-mode root: each immediate subdir becomes an explorer group (optional)
  WAYMONET_HOST/PORT bind addr/port            (default: 0.0.0.0:3106 on the homebox)
"""
import glob
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB = os.environ.get("WAYMONET_DB", os.path.join(ROOT, "data", "waymo.db"))
SPECIAL = os.environ.get("WAYMONET_SPECIAL", os.path.join(ROOT, "data", "special"))
BROWSE = os.environ.get("WAYMONET_BROWSE", "")   # local mode: each immediate subdir -> a group
HOST = os.environ.get("WAYMONET_HOST", "0.0.0.0")
PORT = int(os.environ.get("WAYMONET_PORT", "3106"))
INFER_URL = os.environ.get("WAYMONET_INFER_URL", "http://127.0.0.1:3105/api/infer")
MAX_UPLOAD = 8 * 1024 * 1024


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

    def br_imgs(d, prefix):                   # register + list the *.jpg directly in dir d
        out = []
        for f in sorted(glob.glob(d + "*.jpg")):
            iid = prefix + os.path.basename(f)[:-4]
            if os.path.exists(f):
                reg[iid] = f
                out.append({"id": iid, "label": os.path.basename(f)[:16]})
        return out

    if BROWSE:               # local mode: each subdir of BROWSE = a group; a subdir holding ONLY
        for d in sorted(glob.glob(os.path.join(BROWSE, "*/"))):   # subdirs becomes a nested parent
            gname = os.path.basename(d.rstrip("/"))
            direct = br_imgs(d, "br_" + gname + "_")
            subs = sorted(glob.glob(d + "*/"))
            if subs and not direct:                               # parent with child sub-galleries
                children = []
                for s in subs:
                    sname = os.path.basename(s.rstrip("/"))
                    cimgs = br_imgs(s, "br_" + gname + "_" + sname + "_")
                    if cimgs:
                        children.append({"name": sname.replace("_", " "),
                                         "count": len(cimgs), "images": cimgs})
                if children:
                    tree.append({"name": gname.replace("_", " "),
                                 "count": sum(c["count"] for c in children), "children": children})
            elif direct:
                tree.append({"name": gname.replace("_", " "), "count": len(direct), "images": direct})
    return reg, tree


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

    def _proxy_infer(self, raw):
        """POST image bytes to the inference service and relay its JSON + status verbatim — so a 503
        (model degraded) reaches the caller unchanged. Inference lives in waymonet-infer, not here."""
        req = urllib.request.Request(INFER_URL, data=raw,
                                     headers={"Content-Type": "application/octet-stream"})
        try:
            resp = urllib.request.urlopen(req, timeout=60)
            self._send(resp.status, "application/json", resp.read())
        except urllib.error.HTTPError as e:
            self._send(e.code, "application/json", e.read())
        except Exception as e:
            self._json({"error": f"inference service unreachable: {e}"}, 502)

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
        if path == "/api/infer":                 # browse-time "draw boxes": read the file, proxy it
            p = registry()[0].get(qs.get("id", [""])[0])
            if not p:
                self._json({"error": "unknown id"}, 404)
                return
            try:
                raw = open(p, "rb").read()
            except OSError:
                self._json({"error": "unreadable"}, 400)
                return
            self._proxy_infer(raw)
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
        self._proxy_infer(self.rfile.read(n))


if __name__ == "__main__":
    print(f"waymonet-dash (viewer) {HOST}:{PORT} | infer->{INFER_URL} | "
          f"db={'yes' if os.path.exists(DB) else 'no'}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
