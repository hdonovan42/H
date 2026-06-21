#!/usr/bin/env python3
"""Re-scan the reject pool with the trained WaymoNet — model-detection-first, full-frame review.

Every candidate a human REJECTED is re-judged by the trained model. CRUCIAL DESIGN (2026-06-21):
the bootstrap funnel's bbox only means "a white vehicle is somewhere in this frame" — it does NOT
mark which vehicle is the Waymo. A reject's frame can hold a low-conf non-Waymo (what the funnel
cropped) AND the real Waymo elsewhere. So we score by the model's HIGHEST-CONFIDENCE box anywhere
in the frame (NOT the box matching the funnel bbox), and we review the FULL FRAME with that top box
overlaid — never a crop. Any frame whose top model box >= COLLECT_FLOOR (0.03) is emailed for review.

Architecture mirrors waymonet_worker.py: torch-free HTTP client on the VPS, POSTing each full frame
to the homebox /api/infer (inference stays OFF the memory-bound VPS). It does NOT mutate the
candidates table — results live in a CSV checkpoint (id,conf,x1,y1,x2,y2) so the run is resumable.
When the whole pool is scanned it emails the hits in blocks of BLOCK, highest confidence first.
A flock guard makes concurrent runs safe.

Reply with the # of any frame containing a real Waymo -> rescue: live_capture.py --confirm <ids>.

  .venv/bin/python collector/scan_rejects.py --limit 20 --dry-run   # smoke test (no email)
  .venv/bin/python collector/scan_rejects.py                        # full run + email blocks

Powered by TfL Open Data.
"""
import argparse
import fcntl
import os
import sqlite3
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
DB = os.path.join(BASE, "data", "waymo.db")
PROGRESS = os.path.join(BASE, "data", "candidates", "reject_scan.csv")   # id,conf,x1,y1,x2,y2
DONE_FLAG = os.path.join(BASE, "data", "candidates", "reject_scan.done")
LOCK_PATH = "/tmp/waymo-reject-scan.lock"

sys.path.insert(0, HERE)
import cv2                                     # noqa: E402  (torch-free)
import numpy as np                            # noqa: E402
from email_alert import send_email            # noqa: E402  (requests only — torch-free)

INFER_URL = os.environ.get("WAYMONET_INFER_URL", "http://100.107.138.103:3105/api/infer")
COLLECT_FLOOR = 0.03      # "registers a score at all" — same floor as the live worker
BLOCK = 60                # full frames are large -> smaller blocks keep each review email openable
HTTP_TIMEOUT = 20
BACKOFF = 60              # wait after a homebox error (it may be restarting/down), then retry


def infer(frame_path):
    with open(frame_path, "rb") as f:
        body = f.read()
    r = requests.post(INFER_URL, data=body,
                      headers={"Content-Type": "application/octet-stream"}, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.json().get("boxes", [])


def top_detection(boxes):
    """Highest-confidence WaymoNet box ANYWHERE in the frame -> (conf, [x1,y1,x2,y2]) or (0.0, None).
    Deliberately NOT matched to the funnel candidate bbox — the funnel only says 'a white car is
    here', so the model's own best box is the unit of interest, wherever it is in the scene."""
    best_c, best_b = 0.0, None
    for b in boxes:
        if b["conf"] > best_c:
            best_c = b["conf"]
            best_b = [round(b["x1"], 1), round(b["y1"], 1), round(b["x2"], 1), round(b["y2"], 1)]
    return best_c, best_b


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
        "SELECT id, frame_path FROM candidates "
        "WHERE status='reject' AND frame_path IS NOT NULL ORDER BY id").fetchall()
    con.close()
    done = load_done()
    todo = [r for r in rows if r[0] not in done]
    print(f"[{time.strftime('%H:%M:%S')}] scan set {len(rows)}, already done {len(done)}, "
          f"to scan {len(todo)}" + (f" (capped {limit})" if limit else ""), flush=True)

    fresh = not os.path.exists(PROGRESS)
    f = open(PROGRESS, "a")
    if fresh:
        f.write("id,conf,x1,y1,x2,y2\n")
    n = hits = 0
    i = 0
    while i < len(todo):
        if limit and n >= limit:
            break
        cid, frame_path = todo[i]
        if not os.path.exists(frame_path):
            f.write(f"{cid},0.0,,,,\n"); f.flush(); i += 1; n += 1
            continue
        try:
            boxes = infer(frame_path)
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] infer error id={cid}: {e} — backoff {BACKOFF}s",
                  flush=True)
            time.sleep(BACKOFF)
            continue                              # retry SAME row; progress not lost
        conf, box = top_detection(boxes)
        bx = ",".join(str(v) for v in box) if box else ",,,"
        f.write(f"{cid},{round(conf, 4)},{bx}\n"); f.flush()
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


def _build_frame_sheet(rows, out_path, cols=4, cap=BLOCK):
    """Grid of FULL FRAMES with the model's top box overlaid. rows=[(id,conf,box,crop,frame),...].
    box = [x1,y1,x2,y2] or None. The whole scene is shown (a Waymo anywhere is visible) with the
    highest-confidence WaymoNet detection drawn in red so the eye goes to what the model flagged.
    Falls back to the crop ONLY if the frame is missing. Returns count shown."""
    cells = []
    for cid, conf, box, cp, fp in rows[:cap]:
        im = cv2.imread(fp) if fp else None
        drew_box = im is not None and box is not None
        if im is None and cp:                  # frame pruned/unreadable -> last-resort crop
            im = cv2.imread(cp)
        if im is None:
            continue
        c = im.copy()
        if drew_box:
            x1, y1, x2, y2 = (int(round(v)) for v in box)
            cv2.rectangle(c, (x1, y1), (x2, y2), (0, 0, 255), 2)        # red = top model box
        cv2.rectangle(c, (0, 0), (132, 20), (0, 0, 0), -1)
        cv2.putText(c, f"#{cid} {conf:.2f}", (3, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
        cells.append(c)
    shown = len(cells)
    if shown == 0:
        return 0
    H = max(c.shape[0] for c in cells)
    W = max(c.shape[1] for c in cells)
    cells = [cv2.copyMakeBorder(c, 0, H - c.shape[0], 0, W - c.shape[1],
                                cv2.BORDER_CONSTANT, value=(35, 35, 35)) for c in cells]
    cells += [np.full((H, W, 3), 35, np.uint8)] * ((-len(cells)) % cols)
    grid = np.vstack([np.hstack(cells[i:i + cols]) for i in range(0, len(cells), cols)])
    cv2.imwrite(out_path, grid)
    return shown


def collect_hits():
    """All hits from the checkpoint (top conf >= floor): (id, conf, box, crop_path, frame_path),
    highest confidence first."""
    rec = {}
    for line in open(PROGRESS):
        line = line.strip()
        if not line or line.startswith("id,"):
            continue
        p = line.split(",")
        cid, conf = int(p[0]), float(p[1])
        if conf < COLLECT_FLOOR:
            continue
        box = [float(p[2]), float(p[3]), float(p[4]), float(p[5])] if len(p) >= 6 and p[2] else None
        rec[cid] = (conf, box)
    if not rec:
        return []
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=60)
    placeholders = ",".join("?" * len(rec))
    rows = con.execute(
        f"SELECT id, crop_path, frame_path FROM candidates WHERE id IN ({placeholders})",
        list(rec)).fetchall()
    con.close()
    out = [(cid, rec[cid][0], rec[cid][1], cp, fp) for cid, cp, fp in rows]
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
        shown = _build_frame_sheet(chunk, sheet, cap=len(chunk))
        subj = (f"WaymoWatch: reject re-scan (FULL FRAMES) — block {k + 1}/{nblocks} — "
                f"{shown} frame(s) (conf {lo:.2f}–{hi:.2f})")
        html = (
            f"<p><b>WaymoNet</b> re-scanned the reject pool by its OWN highest-confidence detection "
            f"anywhere in each frame (not the funnel's cropped vehicle). These <b>{shown}</b> frame(s) "
            f"scored conf &ge; {COLLECT_FLOOR}. Block <b>{k + 1} of {nblocks}</b>, highest first.</p>"
            f"<p>Each cell is the <b>FULL FRAME</b> with the model's top box drawn in <b>red</b> and "
            f"labelled #id + conf — so you can see the whole scene and exactly what the model flagged.</p>"
            f"<p>Reply with the <b>#</b> of any frame with a real Waymo (white Jaguar I-PACE, dark roof "
            f"dome) — those are <b>rescues</b>; confirm with <code>live_capture.py --confirm &lt;ids&gt;"
            f"</code>. Everything you don't flag stays a (model-vetted) hard negative.</p>"
            f"<p style='color:#888'>Powered by TfL Open Data.</p>")
        if dry_run:
            print(f"  [dry-run] block {k + 1}/{nblocks}: {shown} FULL-FRAME cells (top box drawn), "
                  f"conf {lo:.2f}-{hi:.2f} -> {sheet} (not sent)", flush=True)
            continue
        if shown and send_email(subj, html, attachments=[sheet]):
            sent += 1
            time.sleep(2)                          # be gentle on the Resend rate limit
        else:
            print(f"  block {k + 1}/{nblocks} send FAILED — rerun to retry (idempotent)", flush=True)
    return sent


def main():
    ap = argparse.ArgumentParser(description="Re-scan the reject pool with trained WaymoNet (full-frame).")
    ap.add_argument("--limit", type=int, help="cap rows scanned this run (testing)")
    ap.add_argument("--dry-run", action="store_true", help="scan + build sheets but do NOT email")
    ap.add_argument("--email-only", action="store_true",
                    help="skip scanning; just (re)build + send the blocks from the checkpoint")
    a = ap.parse_args()

    # single-run guard: don't race a scheduled relaunch or a manual run (shared checkpoint append)
    lock = open(LOCK_PATH, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(f"[{time.strftime('%H:%M:%S')}] another reject-scan holds {LOCK_PATH} — exiting")
        return

    if not a.email_only and not a.dry_run and os.path.exists(DONE_FLAG):
        print(f"[{time.strftime('%H:%M:%S')}] already complete ({DONE_FLAG} present) — "
              f"rm it to re-run. exiting.")
        return

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
