#!/usr/bin/env python3
"""WaymoNet scoring worker — the trained model as the candidate GENERATOR.

Runs on the VPS as a lightweight HTTP client (requests + sqlite + file read — NO torch, so
it can't stress the memory-bound VPS or block the capture loop). For each not-yet-scored
candidate it POSTs the full frame to the homebox WaymoNet endpoint (/api/infer) and records the
verdict from the model's highest-confidence box anywhere in the frame:

  wn_conf      = max conf of WaymoNet's best box anywhere in the frame (0 if the model saw nothing)
  wn_bbox      = that box (WaymoNet's own detection, [x1,y1,x2,y2]) — the digest draws + banks it
  wn_scored    = 1   (this row has been run through the model)
  wn_hit       = 1 if wn_conf >= COLLECT_FLOOR  ("registers a score at all" -> goes to human review)
  wn_scored_at = UTC ISO timestamp of the verdict        (audit)
  wn_attempts  = inference passes it took (2 = an empty that was re-verified; 1 = a first-pass hit)
  wn_model_ver = sha256(best.pt)[:12] the homebox served (audit / targeted re-score by model version)

A zero is the dangerous result: a degraded-but-reachable model returns [] for a real Waymo, banked
terminally and invisibly (the per-request flake that missed #43895 — a global health canary can't see
it). So empties are RE-VERIFIED (re-run up to ZERO_RECHECK times); only a SECOND agreeing empty is
trusted. Unreachable (timeout/503/refused) raises -> row left unscored -> retried next pass, so
homebox downtime is a delay that piles up candidates, never a dropped or false-zeroed detection.

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
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
DB = os.path.join(BASE, "data", "waymo.db")

INFER_URL = os.environ.get("WAYMONET_INFER_URL", "http://100.107.138.103:3105/api/infer")
COLLECT_FLOOR = 0.03      # "registers a score at all" — the homebox endpoint's own BASE_CONF
BATCH = 200               # rows per query pass
HTTP_TIMEOUT = 20         # seconds per inference POST
IDLE_SLEEP = 30           # seconds to wait when the queue is empty
BACKOFF = 60              # seconds to wait after a homebox error (it may be restarting/down)
ZERO_RECHECK = 1          # extra inference passes on an EMPTY result before trusting the zero
ZERO_RECHECK_DELAY = 0.3  # seconds between an empty pass and its re-verify (lets a transient clear)


def _oom_self_protect():
    try:
        with open("/proc/self/oom_score_adj", "w") as f:
            f.write("700")
    except Exception:
        pass


def _ensure_schema(con):
    """Self-migrate the audit columns (idempotent) so a deploy needs no manual ALTER."""
    cols = {r[1] for r in con.execute("PRAGMA table_info(candidates)")}
    for name, typ in (("wn_scored_at", "TEXT"), ("wn_attempts", "INTEGER"), ("wn_model_ver", "TEXT")):
        if name not in cols:
            con.execute(f"ALTER TABLE candidates ADD COLUMN {name} {typ}")
    con.commit()


def infer(frame_path):
    """POST the frame bytes to the homebox model; return (boxes, model_ver). Raises on failure."""
    with open(frame_path, "rb") as f:
        body = f.read()
    r = requests.post(INFER_URL, data=body,
                      headers={"Content-Type": "application/octet-stream"}, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    j = r.json()
    return j.get("boxes", []), j.get("model_ver")


def _best_box(boxes):
    """The model's highest-conf box anywhere in the frame -> (conf, [x1,y1,x2,y2]) or (0.0, None).

    Deliberately NOT matched to the funnel bbox: the funnel only says 'a white vehicle is somewhere
    here', not which one is the Waymo, so the model's own best box is the unit of interest/review
    (aligned with scan_rejects.py + waymonet_digest.py, 2026-06-21)."""
    best_conf, best_box = 0.0, None
    for b in boxes:
        if b["conf"] > best_conf:
            best_conf = b["conf"]
            best_box = [round(b["x1"], 1), round(b["y1"], 1), round(b["x2"], 1), round(b["y2"], 1)]
    return best_conf, best_box


def score_row(con, row):
    """Score one candidate. Returns (ok, hit): ok=False only if the model was unreachable.

    Re-verify on empty (Fix 1, v0.8.75): an empty pass is re-run up to ZERO_RECHECK times; only a
    second agreeing empty is banked. A hit short-circuits immediately. The HTTP inference happens
    OUTSIDE any DB transaction; the write is a single brief UPDATE + commit per row, so the SQLite
    write lock is held ~1 ms and never blocks the live capture loop (the batch-held-lock bug,
    v0.8.63)."""
    cid, frame_path = row
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if not frame_path or not os.path.exists(frame_path):
        con.execute("UPDATE candidates SET wn_scored=1, wn_conf=0, wn_hit=0, wn_bbox=NULL, "
                    "wn_scored_at=?, wn_attempts=0, wn_model_ver='no-frame' WHERE id=?", (now, cid))
        con.commit()
        return True, 0
    best_conf, best_box, model_ver, attempts = 0.0, None, None, 0
    try:
        for attempt in range(1, ZERO_RECHECK + 2):       # 1 initial pass + ZERO_RECHECK re-verifies
            boxes, model_ver = infer(frame_path)         # network/inference — NO open transaction
            attempts = attempt
            c, b = _best_box(boxes)
            if c > best_conf:                            # keep the max across passes
                best_conf, best_box = c, b
            if best_conf >= COLLECT_FLOOR:               # a detection — trust it, skip the re-verify
                break
            if attempt <= ZERO_RECHECK:                  # empty -> brief pause, then re-verify
                time.sleep(ZERO_RECHECK_DELAY)
    except Exception as e:
        print(f"[{time.strftime('%H:%M:%S')}] infer error id={cid}: {e}", flush=True)
        return False, 0                                  # unreachable -> leave unscored, retry later
    hit = 1 if best_conf >= COLLECT_FLOOR else 0
    con.execute("UPDATE candidates SET wn_conf=?, wn_bbox=?, wn_scored=1, wn_hit=?, "
                "wn_scored_at=?, wn_attempts=?, wn_model_ver=? WHERE id=?",
                (round(best_conf, 4), json.dumps(best_box) if best_box else None, hit,
                 now, attempts, model_ver, cid))
    con.commit()                                         # brief, per-row — frees the lock immediately
    return True, hit


def run(once=False, limit=None):
    _oom_self_protect()
    con = sqlite3.connect(DB, timeout=60)
    _ensure_schema(con)
    total, hits = 0, 0
    while True:
        rows = con.execute(
            "SELECT id, frame_path FROM candidates "
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
