#!/usr/bin/env python3
"""WaymoNet INFERENCE SERVICE — model + /api/infer only. Pipeline-critical; NO UI.

Decoupled from the dash viewer (2026-06-21): the detection worker (VPS) POSTs candidate frames here
to be scored; the dash UI is a SEPARATE process that proxies to this. So a viewer change/restart can
never disturb detection, and vice versa. Runs best.pt (ultralytics, CPU), one inference at a time.

Health watchdog: a background canary probes a known-Waymo frame every CANARY_EVERY s. While the model
is in a silent empty-return window, /api/infer returns 503 on a ZERO result (so the worker retries and
never banks a false 0); sustained failure exits for a systemd restart + emails the operator. A degraded
model can therefore only cause a brief DELAY, never a missed detection.

Env: WAYMONET_WEIGHTS, WAYMONET_HOST (0.0.0.0), WAYMONET_PORT (3105), WAYMONET_CANARY.
"""
import hashlib
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
WEIGHTS = os.environ.get("WAYMONET_WEIGHTS", os.path.join(HERE, "best.pt"))
HOST = os.environ.get("WAYMONET_HOST", "0.0.0.0")
PORT = int(os.environ.get("WAYMONET_PORT", "3105"))
IMGSZ = 704
BASE_CONF = 0.03
MAX_UPLOAD = 8 * 1024 * 1024
CANARY = os.environ.get("WAYMONET_CANARY", os.path.join(HERE, "canary_waymo.jpg"))
CANARY_MIN = 0.30
CANARY_EVERY = 3.0
CANARY_DEADCOUNT = 5            # consecutive fails (~15 s) -> exit for a systemd restart
KEYFILE = os.path.join(HERE, ".resend_key")
ALERT_TO = "donovanh59@gmail.com"

_model = None
_lock = threading.Lock()
_healthy = True


def _compute_model_ver():
    """sha256(best.pt)[:12] — a stable content identity for the served weights, recorded by the
    worker (wn_model_ver) so a future model swap can target a precise re-score by version."""
    try:
        h = hashlib.sha256()
        with open(WEIGHTS, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()[:12]
    except Exception:
        return "unknown"


MODEL_VER = _compute_model_ver()


def model():
    global _model
    if _model is None:
        from ultralytics import YOLO
        _model = YOLO(WEIGHTS)
    return _model


def infer(img):
    """Run WaymoNet on a BGR ndarray; {w,h,time_ms,boxes:[{x1,y1,x2,y2,conf}]} (>=BASE_CONF), conf desc."""
    with _lock:
        t = time.time()
        r = model().predict(img, conf=BASE_CONF, imgsz=IMGSZ, verbose=False)[0]
        dt = (time.time() - t) * 1000
    h, w = img.shape[:2]
    boxes = [{"x1": round(float(b.xyxy[0][0]), 1), "y1": round(float(b.xyxy[0][1]), 1),
              "x2": round(float(b.xyxy[0][2]), 1), "y2": round(float(b.xyxy[0][3]), 1),
              "conf": round(float(b.conf[0]), 3)} for b in r.boxes]
    boxes.sort(key=lambda b: -b["conf"])
    return {"w": w, "h": h, "time_ms": round(dt), "model_ver": MODEL_VER, "boxes": boxes}


def _alert(subject, html):
    try:
        key = open(KEYFILE).read().split("=", 1)[1].strip()
        import urllib.request
        req = urllib.request.Request(
            "https://api.resend.com/emails",
            data=json.dumps({"from": "WaymoWatch <noreply@autosnipe.co.uk>", "to": [ALERT_TO],
                             "subject": subject, "html": html}).encode(),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=20).read()
    except Exception as e:
        print(f"alert failed: {e}", flush=True)


def _canary_loop():
    global _healthy
    img = cv2.imread(CANARY) if os.path.exists(CANARY) else None
    if img is None:
        print(f"canary frame missing ({CANARY}) — watchdog DISABLED", flush=True)
        return
    fails = 0
    while True:
        time.sleep(CANARY_EVERY)
        try:
            r = infer(img)
            top = r["boxes"][0]["conf"] if r["boxes"] else 0.0
        except Exception:
            top = -1.0
        if top >= CANARY_MIN:
            if not _healthy:
                print(f"canary recovered (conf {top})", flush=True)
            _healthy, fails = True, 0
        else:
            fails += 1
            if _healthy:
                print(f"canary FAIL (conf {top}) — degraded; returning 503 on empties", flush=True)
            _healthy = False
            if fails >= CANARY_DEADCOUNT:
                print(f"canary dead x{fails} -> exit for systemd restart", flush=True)
                _alert("WaymoNet inference: model degraded — auto-restarting",
                       f"<p>The inference service failed its canary {fails}x "
                       f"(~{int(CANARY_EVERY * fails)}s) and is restarting via systemd. While degraded it "
                       f"returned 503 on empty results so the worker retried — no candidate was recorded "
                       f"as a false zero.</p>")
                os._exit(1)


class Handler(BaseHTTPRequestHandler):
    server_version = "waymonet-infer"

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json({"healthy": _healthy})
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path != "/api/infer":
            self._json({"error": "not found"}, 404)
            return
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > MAX_UPLOAD:
            self._json({"error": f"bad upload size (max {MAX_UPLOAD} bytes)"}, 400)
            return
        img = cv2.imdecode(np.frombuffer(self.rfile.read(n), np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            self._json({"error": "not a decodable image"}, 400)
            return
        r = infer(img)
        if not r["boxes"] and not _healthy:        # degraded -> 503 so the worker retries, never a false 0
            self._json({"error": "model degraded (canary failing) — retry"}, 503)
        else:
            self._json(r)


if __name__ == "__main__":
    print(f"waymonet-infer {HOST}:{PORT} | weights={WEIGHTS}", flush=True)
    model()  # warm at startup
    print("model warm — serving", flush=True)
    threading.Thread(target=_canary_loop, daemon=True).start()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
