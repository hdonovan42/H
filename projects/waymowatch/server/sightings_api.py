"""WaymoWatch sightings API — read-only, public.

Serves confirmed Waymo sightings (status='waymo') from waymo.db to the
dashboard on https://hjd.ai/projects/waymowatch/. Sits on 127.0.0.1:3104
behind nginx (https://axiom.hjd.ai/waymowatch/ -> / here).

Routes:
  GET /api/sightings        all confirmed sightings + camera metadata
  GET /img/<id>.jpg         vehicle crop for a confirmed sighting
  GET /img/<id>_frame.jpg   full annotated frame for a confirmed sighting

No auth: the data is what the public map displays anyway. Images are
served only for status='waymo' rows — unreviewed candidates stay private.
"""

import json
import re
import sqlite3
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "waymo.db"
PORT = 3104
SIGHTING_GAP_S = 600   # same camera within 10 min = ONE pass (no track_id; JamCams poll ~150 s)

IMG_RE = re.compile(r"^/img/(\d+)(_frame)?\.jpg$")


def db():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=60)
    con.row_factory = sqlite3.Row
    return con


def _ts(s):
    """Parse 'YYYY-MM-DDThh:mm:ss[.f]Z' to a datetime (for pass-gap maths)."""
    return datetime.strptime((s or "").replace("Z", "").split(".")[0], "%Y-%m-%dT%H:%M:%S")


def sightings():
    """Confirmed sightings, deduped to distinct PASSES for the public map.

    A Waymo snapped several frames apart (same camera, consecutive frames within SIGHTING_GAP_S)
    is ONE sighting, not three — the map dots, popup paging AND the bottom-left total all count
    passes, not raw frames. Only the presentation dedups; training (build_real_dataset) still keeps
    every frame. Representative of a pass = its highest-confidence frame; `frames` = how many
    collapsed into it. There's no track_id, so the key is (camera, time-chained within the gap)."""
    con = db()
    try:
        rows = con.execute(
            """SELECT c.id, c.camera_id, c.captured_at, c.score, c.wn_conf,
                      cam.common_name, cam.view, cam.lat, cam.lon
               FROM candidates c JOIN cameras cam ON cam.id = c.camera_id
               WHERE c.status = 'waymo'
               ORDER BY c.camera_id, c.captured_at"""        # camera then time -> consecutive = same pass
        ).fetchall()
    finally:
        con.close()

    KEYS = ("id", "camera_id", "captured_at", "score", "common_name", "view", "lat", "lon")
    events, cluster, prev = [], [], None

    def flush():
        if not cluster:
            return
        rep = max(cluster, key=lambda r: (r["wn_conf"] if r["wn_conf"] is not None else -1.0,
                                          r["score"] if r["score"] is not None else -1.0))
        ev = {k: rep[k] for k in KEYS}
        ev["frames"] = len(cluster)
        events.append(ev)

    for r in rows:
        same_pass = prev is not None and r["camera_id"] == prev["camera_id"]
        if same_pass:
            try:
                same_pass = (_ts(r["captured_at"]) - _ts(prev["captured_at"])).total_seconds() <= SIGHTING_GAP_S
            except (ValueError, TypeError):
                same_pass = False        # unparseable timestamp -> treat as a separate pass
        if not same_pass:
            flush()
            cluster.clear()
        cluster.append(r)
        prev = r
    flush()

    events.sort(key=lambda e: e["captured_at"], reverse=True)   # frontend expects newest-first
    return events


def image_path(cand_id, frame):
    con = db()
    try:
        row = con.execute(
            "SELECT crop_path, frame_path FROM candidates WHERE id=? AND status='waymo'",
            (cand_id,),
        ).fetchone()
    finally:
        con.close()
    if not row:
        return None
    p = Path(row["frame_path" if frame else "crop_path"])
    return p if p.is_file() else None


class Handler(BaseHTTPRequestHandler):
    server_version = "waymowatch-api"

    def log_message(self, fmt, *args):
        pass  # nginx has the access log

    def _headers(self, code, ctype, length, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", cache)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path == "/api/sightings":
            body = json.dumps({"sightings": sightings()}).encode()
            self._headers(200, "application/json", len(body))
            self.wfile.write(body)
            return

        m = IMG_RE.match(path)
        if m:
            p = image_path(int(m.group(1)), bool(m.group(2)))
            if p:
                body = p.read_bytes()
                # confirmed sightings are immutable once banked
                self._headers(200, "image/jpeg", len(body), "public, max-age=86400")
                self.wfile.write(body)
                return

        body = b'{"error": "not found"}'
        self._headers(404, "application/json", len(body))
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
