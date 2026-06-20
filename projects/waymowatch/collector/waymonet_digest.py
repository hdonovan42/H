#!/usr/bin/env python3
"""WaymoNet review email — the human precision gate for the model's own candidates.

Emails the candidates WaymoNet flagged (wn_hit=1) that haven't been reviewed or sent yet,
ranked by model confidence. The user replies with the # of any real Waymo; reply handling is
the EXISTING `live_capture.py --confirm` / `--reject` (confirms -> fresh positives, denies ->
fresh hard negatives). Reuses the digest sheet builder + the Resend sender, so nothing about
the review/confirm flow changes — only the candidate SOURCE (WaymoNet instead of the dome scorer).

  .venv/bin/python collector/waymonet_digest.py            # send pending wn_hit candidates
  .venv/bin/python collector/waymonet_digest.py --dry-run  # build the sheet, don't send/mark

Powered by TfL Open Data.
"""
import argparse
import os
import sqlite3
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
DB = os.path.join(BASE, "data", "waymo.db")
sys.path.insert(0, HERE)
from email_alert import send_email              # noqa: E402  (lightweight: requests only — NO torch)

MAX_CELLS = 200


def _build_sheet(rows, out_path, cols=6, cap=200):
    """Grid of crops labelled '#id conf'. rows = [(id, conf, crop_path), ...]. Returns count shown.
    Inlined (not imported from live_capture) so this stays torch-free on the VPS."""
    cells = []
    for cid, sc, cp in rows[:cap]:
        im = cv2.imread(cp) if cp else None
        if im is None:
            continue
        c = cv2.resize(im, (200, 150), interpolation=cv2.INTER_NEAREST)
        cv2.rectangle(c, (0, 0), (96, 20), (0, 0, 0), -1)
        cv2.putText(c, f"#{cid} {sc:.2f}", (3, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (0, 255, 255), 1)
        cells.append(c)
    shown = len(cells)
    if shown == 0:
        return 0
    cells += [np.full((150, 200, 3), 35, np.uint8)] * ((-len(cells)) % cols)
    grid = np.vstack([np.hstack(cells[i:i + cols]) for i in range(0, len(cells), cols)])
    cv2.imwrite(out_path, grid)
    return shown


def main():
    ap = argparse.ArgumentParser(description="Email WaymoNet's flagged candidates for review.")
    ap.add_argument("--limit", type=int, default=MAX_CELLS)
    ap.add_argument("--min", type=int, default=30, dest="min_pile",
                    help="only send once at least this many unsent flagged candidates have piled up")
    ap.add_argument("--force", action="store_true", help="send now regardless of --min")
    ap.add_argument("--dry-run", action="store_true", help="build the sheet but don't send or mark")
    a = ap.parse_args()

    con = sqlite3.connect(DB, timeout=60)
    rows = con.execute(
        "SELECT id, wn_conf, crop_path FROM candidates "
        "WHERE wn_hit=1 AND COALESCE(wn_sent,0)=0 AND status NOT IN ('waymo','reject') "
        "AND crop_path IS NOT NULL ORDER BY wn_conf DESC LIMIT ?", (a.limit,)).fetchall()
    if not rows:
        print("no unsent WaymoNet-flagged candidates")
        return
    if len(rows) < a.min_pile and not a.force and not a.dry_run:
        print(f"only {len(rows)} flagged (< {a.min_pile}) — holding until {a.min_pile} pile up")
        return

    sheet = os.path.join(BASE, "data/candidates/waymonet_review.jpg")
    shown = _build_sheet(rows, sheet, cap=len(rows))
    lo, hi = rows[-1][1], rows[0][1]
    subj = f"WaymoWatch: WaymoNet flagged {shown} candidate(s) for review (conf {lo:.2f}–{hi:.2f})"
    html = (
        f"<p><b>WaymoNet</b> (the trained model) flagged these <b>{shown}</b> candidate(s) as a "
        f"possible Waymo (any detection at conf &ge; 0.03). Labelled with the model confidence.</p>"
        f"<p>Reply with the <b>#</b> of any that is a real Waymo (white Jaguar I-PACE, dark roof "
        f"dome). Everything you don't flag becomes a hard negative — the model is building its own "
        f"higher-signal dataset.</p>"
        f"<p style='color:#888'>Powered by TfL Open Data.</p>")

    if a.dry_run:
        print(f"[dry-run] {shown} candidate(s), conf {lo:.2f}–{hi:.2f} -> {sheet} (not sent)")
        return
    if shown and send_email(subj, html, attachments=[sheet]):
        ids = [r[0] for r in rows]
        con.execute("UPDATE candidates SET wn_sent=1 WHERE id IN (%s)"
                    % ",".join(str(int(i)) for i in ids))
        con.commit()
        print(f"sent {shown} WaymoNet candidate(s) for review; marked wn_sent=1")
    else:
        print("send failed or nothing to show — leaving wn_sent=0 for retry")


if __name__ == "__main__":
    main()
