#!/usr/bin/env python3
"""One-off batch: re-scan the original (Phase-0) reject pool with the trained WaymoNet.

Every candidate the cheap bootstrap funnel surfaced and a human REJECTED is run through the
trained model — the model gets to disagree. Any reject whose own tracked bbox region scores a
WaymoNet detection at conf >= COLLECT_FLOOR (0.03, the homebox endpoint's BASE_CONF) is collected
and emailed for review. These are rescue candidates: a real Waymo the human review missed, or the
genuinely-hardest negatives. (This is the rejcheck audit done exhaustively, by the trained model.)

Architecture mirrors waymonet_worker.py: runs on the VPS as a torch-free HTTP client, POSTing each
full frame to the homebox /api/infer (inference stays OFF the memory-bound VPS). It does NOT mutate
the candidates table (the live wn pipeline excludes rejects by design) — results live in a CSV
checkpoint so the run is resumable. When the whole pool is scanned it emails the hits in blocks of
BLOCK (200), highest model-confidence first.

Reply with the # of any real Waymo -> rescue it the normal way: live_capture.py --confirm <ids>.

  .venv/bin/python collector/scan_rejects.py --limit 20 --dry-run   # smoke test (no email)
  .venv/bin/python collector/scan_rejects.py                        # full run + email blocks

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
PROGRESS = os.path.join(BASE, "data", "candidates", "reject_scan.csv")   # id,conf per scored row
DONE_FLAG = os.path.join(BASE, "data", "candidates", "reject_scan.done")

sys.path.insert(0, HERE)
from email_alert import send_email          # noqa: E402  (requests only — torch-free)
from waymonet_digest import _build_sheet    # noqa: E402  (cv2/numpy — torch-free)

INFER_URL = os.environ.get("WAYMONET_INFER_URL", "http://100.107.138.103:3105/api/infer")
COLLECT_FLOOR = 0.03      # "registers a score at all" — same floor as the live worker
IOU_MATCH = 0.30          # match a WaymoNet box to the candidate's tracked bbox (as in eval_gate)
BLOCK = 200               # candidates per review email
HTTP_TIMEOUT = 20
BACKOFF = 60              # wait after a homebox error (it may be restarting/down), then retry


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def infer(frame_path):
    with open(frame_path, "rb") as f:
        body = f.read()
    r = requests.post(INFER_URL, data=body,
                      headers={"Content-Type": "application/octet-stream"}, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.json().get("boxes", [])


def best_match_conf(boxes, cbb):
    """Max conf of a WaymoNet box that IoU-matches the candidate's bbox (0.0 if none)."""
    best = 0.0
    for b in boxes:
        box = (b["x1"], b["y1"], b["x2"], b["y2"])
        if iou(cbb, box) >= IOU_MATCH and b["conf"] > best:
            best = b["conf"]
    return best


def load_done():
    done = set()
    if os.path.exists(PROGRESS):
        for line in open(PROGRESS):
            line = line.strip()
            if line and not line.startswith("id,"):
                try:
                    done.add(int(line.split(",")[0]))
                except ValueError:
                    pass
    return done


def scan(limit=None):
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=60)
    rows = con.execute(
        "SELECT id, frame_path, bbox FROM candidates "
        "WHERE status='reject' AND COALESCE(wn_scored,0)=0 AND frame_path IS NOT NULL "
        "AND bbox IS NOT NULL ORDER BY id").fetchall()
    con.close()
    done = load_done()
    todo = [r for r in rows if r[0] not in done]
    print(f"[{time.strftime('%H:%M:%S')}] scan set {len(rows)}, already done {len(done)}, "
          f"to scan {len(todo)}" + (f" (capped {limit})" if limit else ""), flush=True)

    fresh = not os.path.exists(PROGRESS)
    f = open(PROGRESS, "a")
    if fresh:
        f.write("id,conf\n")
    n = hits = 0
    i = 0
    while i < len(todo):
        if limit and n >= limit:
            break
        cid, frame_path, bbox_json = todo[i]
        if not os.path.exists(frame_path):
            f.write(f"{cid},0.0\n"); f.flush(); i += 1; n += 1
            continue
        try:
            boxes = infer(frame_path)
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] infer error id={cid}: {e} — backoff {BACKOFF}s",
                  flush=True)
            time.sleep(BACKOFF)
            continue                              # retry SAME row; progress not lost
        conf = best_match_conf(boxes, json.loads(bbox_json))
        f.write(f"{cid},{round(conf, 4)}\n"); f.flush()
        if conf >= COLLECT_FLOOR:
            hits += 1
        i += 1; n += 1
        if n % 200 == 0:
            print(f"[{time.strftime('%H:%M:%S')}] scanned {n}/{len(todo)} (hits so far {hits})",
                  flush=True)
    f.close()
    remaining = len(todo) - n
    print(f"[{time.strftime('%H:%M:%S')}] pass done: scanned {n}, hits this pass {hits}, "
          f"remaining {remaining}", flush=True)
    return remaining


def collect_hits():
    """All hits from the checkpoint (conf >= floor), enriched with crop/frame paths, conf desc."""
    hit_conf = {}
    for line in open(PROGRESS):
        line = line.strip()
        if not line or line.startswith("id,"):
            continue
        cid, conf = line.split(",")
        conf = float(conf)
        if conf >= COLLECT_FLOOR:
            hit_conf[int(cid)] = conf
    if not hit_conf:
        return []
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=60)
    placeholders = ",".join("?" * len(hit_conf))
    rows = con.execute(
        f"SELECT id, crop_path, frame_path FROM candidates WHERE id IN ({placeholders})",
        list(hit_conf)).fetchall()
    con.close()
    out = [(cid, hit_conf[cid], cp, fp) for cid, cp, fp in rows]
    out.sort(key=lambda r: -r[1])             # highest model confidence first
    return out


def email_blocks(hits, dry_run=False):
    n = len(hits)
    nblocks = (n + BLOCK - 1) // BLOCK
    print(f"[{time.strftime('%H:%M:%S')}] {n} hit(s) >= {COLLECT_FLOOR} -> {nblocks} block(s) of {BLOCK}",
          flush=True)
    sent = 0
    for k in range(nblocks):
        chunk = hits[k * BLOCK:(k + 1) * BLOCK]
        lo, hi = chunk[-1][1], chunk[0][1]
        sheet = os.path.join(BASE, f"data/candidates/reject_scan_block{k + 1}.jpg")
        rows = [(cid, conf, cp, fp) for cid, conf, cp, fp in chunk]
        shown = _build_sheet(rows, sheet, cap=len(rows))
        subj = (f"WaymoWatch: reject-pool re-scan — block {k + 1}/{nblocks} — "
                f"{shown} candidate(s) (conf {lo:.2f}–{hi:.2f})")
        html = (
            f"<p><b>WaymoNet</b> (the trained model) re-scanned the original Phase-0 reject pool "
            f"and scored these <b>{shown}</b> rejected candidate(s) as a possible Waymo "
            f"(its own detection on the candidate, conf &ge; {COLLECT_FLOOR}). Block "
            f"<b>{k + 1} of {nblocks}</b>, highest confidence first. Labelled with the model conf.</p>"
            f"<p>Reply with the <b>#</b> of any that is genuinely a Waymo (white Jaguar I-PACE, dark "
            f"roof dome) — those are <b>rescues from the reject pool</b>; confirm them with "
            f"<code>live_capture.py --confirm &lt;ids&gt;</code>. Everything you don't flag stays a "
            f"(now model-vetted) hard negative.</p>"
            f"<p style='color:#888'>Powered by TfL Open Data.</p>")
        if dry_run:
            print(f"  [dry-run] block {k + 1}/{nblocks}: {shown} cells, conf {lo:.2f}-{hi:.2f} "
                  f"-> {sheet} (not sent)", flush=True)
            continue
        if shown and send_email(subj, html, attachments=[sheet]):
            sent += 1
            time.sleep(2)                          # be gentle on the Resend rate limit
        else:
            print(f"  block {k + 1}/{nblocks} send FAILED — rerun to retry (idempotent)", flush=True)
    return sent


def main():
    ap = argparse.ArgumentParser(description="Re-scan the Phase-0 reject pool with trained WaymoNet.")
    ap.add_argument("--limit", type=int, help="cap rows scanned this run (testing)")
    ap.add_argument("--dry-run", action="store_true", help="scan + build sheets but do NOT email")
    ap.add_argument("--email-only", action="store_true",
                    help="skip scanning; just (re)build + send the blocks from the checkpoint")
    a = ap.parse_args()

    if not a.email_only:
        remaining = scan(limit=a.limit)
        if remaining > 0:
            print(f"[{time.strftime('%H:%M:%S')}] {remaining} still unscanned (limit/backoff) — "
                  f"NOT emailing yet; rerun to finish.", flush=True)
            return

    hits = collect_hits()
    sent = email_blocks(hits, dry_run=a.dry_run)
    if not a.dry_run and hits and sent == ((len(hits) + BLOCK - 1) // BLOCK):
        open(DONE_FLAG, "w").write(time.strftime("%Y-%m-%dT%H:%M:%S"))
    print(f"[{time.strftime('%H:%M:%S')}] DONE — {len(hits)} hits, {sent} block email(s) sent.",
          flush=True)


if __name__ == "__main__":
    main()
