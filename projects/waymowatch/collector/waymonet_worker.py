#!/usr/bin/env python3
"""WaymoNet scoring worker — the trained model as the candidate GENERATOR.

Runs on the VPS as a lightweight HTTP client (requests + sqlite + file read — NO torch, so
it can't stress the memory-bound VPS or block the capture loop). For each not-yet-scored
candidate it POSTs the full frame to the homebox WaymoNet endpoint (/api/infer), matches the
returned detections to the candidate's tracked bbox, and records the verdict:

  wn_conf   = max conf of a WaymoNet box with IoU >= IOU_MATCH on the candidate's bbox (0 if none)
  wn_bbox   = that box  (WaymoNet's own detection, [x1,y1,x2,y2])
  wn_scored = 1         (this row has been run through the model)
  wn_hit    = 1 if wn_conf >= COLLECT_FLOOR  ("registers a score at all" -> goes to human review)

Anything with wn_hit=1 is surfaced by collector/waymonet_digest.py for manual confirm/deny.
Confirms become fresh positives, denies become high-signal hard negatives — the model curates
its own next-generation dataset. Inference stays OFF the VPS (homebox, per CHANGELOG v0.8.60).

  .venv/bin/python collector/waymonet_worker.py            # loop forever, newest-first
  .venv/bin/python collector/waymonet_worker.py --once --limit 300   # one bounded pass (testing)

Powered by TfL Open Data.
"""
import argparse
import json
import os
import sqlite3
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
DB = os.path.join(BASE, "data", "waymo.db")

INFER_URL = os.environ.get("WAYMONET_INFER_URL", "http://100.107.138.103:3105/api/infer")
COLLECT_FLOOR = 0.03      # "registers a score at all" — the homebox endpoint's own BASE_CONF
IOU_MATCH = 0.30          # match a WaymoNet box to the candidate's tracked bbox (as in eval_gate)
BATCH = 200               # rows per query pass
HTTP_TIMEOUT = 20         # seconds per inference POST
IDLE_SLEEP = 30           # seconds to wait when the queue is empty
BACKOFF = 60              # seconds to wait after a homebox error (it may be restarting/down)


def _oom_self_protect():
    try:
        with open("/proc/self/oom_score_adj", "w") as f:
            f.write("700")
    except Exception:
        pass


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def infer(frame_path):
    """POST the frame bytes to the homebox model; return its detection boxes (raises on failure)."""
    with open(frame_path, "rb") as f:
        body = f.read()
    r = requests.post(INFER_URL, data=body,
                      headers={"Content-Type": "application/octet-stream"}, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.json().get("boxes", [])


def score_row(con, row):
    """Score one candidate. Returns (ok, hit): ok=False only if the model was unreachable.

    The HTTP inference happens OUTSIDE any DB transaction; the write is a single brief
    UPDATE + commit per row, so the SQLite write lock is held ~1 ms and never blocks the
    live capture loop (the batch-held-lock bug, v0.8.63)."""
    cid, frame_path, bbox_json = row
    if not frame_path or not os.path.exists(frame_path):
        con.execute("UPDATE candidates SET wn_scored=1, wn_conf=0, wn_hit=0 WHERE id=?", (cid,))
        con.commit()
        return True, 0
    try:
        boxes = infer(frame_path)            # network/inference — NO open transaction here
    except Exception as e:
        print(f"[{time.strftime('%H:%M:%S')}] infer error id={cid}: {e}", flush=True)
        return False, 0
    cbb = json.loads(bbox_json) if bbox_json else None
    best_conf, best_box = 0.0, None
    for b in boxes:
        box = (b["x1"], b["y1"], b["x2"], b["y2"])
        if cbb and iou(cbb, box) >= IOU_MATCH and b["conf"] > best_conf:
            best_conf, best_box = b["conf"], box
    hit = 1 if best_conf >= COLLECT_FLOOR else 0
    con.execute("UPDATE candidates SET wn_conf=?, wn_bbox=?, wn_scored=1, wn_hit=? WHERE id=?",
                (round(best_conf, 4), json.dumps(best_box) if best_box else None, hit, cid))
    con.commit()                             # brief, per-row — frees the lock immediately
    return True, hit


def run(once=False, limit=None):
    _oom_self_protect()
    con = sqlite3.connect(DB, timeout=60)
    total, hits = 0, 0
    while True:
        rows = con.execute(
            "SELECT id, frame_path, bbox FROM candidates "
            "WHERE COALESCE(wn_scored,0)=0 AND status NOT IN ('waymo','reject') "
            "ORDER BY id DESC LIMIT ?", (BATCH,)).fetchall()
        if not rows:
            if once:
                break
            time.sleep(IDLE_SLEEP)
            continue
        stop = False
        for row in rows:
            if limit and total >= limit:
                stop = True
                break
            ok, hit = score_row(con, row)    # commits per row; lock held ~1 ms
            if not ok:                       # homebox down — back off, retry (progress is saved)
                print(f"[{time.strftime('%H:%M:%S')}] homebox unreachable; backing off {BACKOFF}s "
                      f"(scored {total} so far, {hits} hits)", flush=True)
                if once:
                    return total, hits
                time.sleep(BACKOFF)
                break
            total += 1
            hits += hit
        print(f"[{time.strftime('%H:%M:%S')}] scored {total} (hits {hits})", flush=True)
        if stop:
            break
        # once-mode terminates at the top when the queue drains (rows empty)
    return total, hits


def main():
    ap = argparse.ArgumentParser(description="WaymoNet scoring worker (homebox /api/infer).")
    ap.add_argument("--once", action="store_true", help="one pass then exit (else loop forever)")
    ap.add_argument("--limit", type=int, help="cap rows scored this run")
    a = ap.parse_args()
    total, hits = run(once=a.once, limit=a.limit)
    print(f"done: scored {total}, wn_hit {hits}")


if __name__ == "__main__":
    main()
