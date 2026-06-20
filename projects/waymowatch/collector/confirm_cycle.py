#!/usr/bin/env python3
"""Consolidated per-confirm cycle (v0.8.14) — ONE email per confirm batch.

Measured rationale (2026-06-11): ranked pages produced ~82% of the first 34
confirms; per-cycle retrospectives and rejects re-checks produced ZERO in the
last ~10 cycles, and mining sheets were ~90% rows the pages had already sent.
So the follow-up flood is consolidated into one email, and the retro/rejcheck
become trigger-based instead of per-confirm.

Run ON THE VPS, after:
  1. live_capture.py --confirm <ids>          (confirms banked)
  2. the re-seeded dome_centroid_tight.json has been rsynced up

Usage:  .venv/bin/python collector/confirm_cycle.py 1234,5678 [--force-retro]
        [--force-rejcheck]

Does, in order:
  - re-score the WHOLE archive against the deployed centroid (stored embs)
  - print reals floor/max + non-waymo quantiles (bar re-anchoring is decided
    by the operator from these numbers; bars live in live_capture.py)
  - re-bucket near<->new at the current PROB_TH
  - ONE consolidated email: echo images (crop + frame) for every confirm in
    the batch (verification rule: "if NOT a Waymo, reply 'undo #id'") + a
    combined NEW-TO-YOU sheet — only never-sent rows within +/-45 min of any
    confirm, ranked by max cosine to any confirm. Skipped if < MIN_SHEET rows.
  - retrospective top-200: only if >= RETRO_EVERY_CONFIRMS confirms since the
    last retro (kv cycle:last_retro_confirms) or --force-retro (use after bar
    changes — that's when the ranking actually moves)
  - rejects re-check top-100: only if >= REJCHECK_EVERY_DAYS days since last
    (kv cycle:last_rejcheck) or --force-rejcheck

Every shown candidate id is appended to data/candidates/cycle_shown.json, so
a "no waymos" verdict banks EXACTLY what was reviewed (bank_shown.py) — no
reproduce-by-query, no mtime cutoffs. Shown rows are flagged sent=1.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import data_plane as dp  # noqa: E402
from live_capture import _build_sheet, PROB_TH, CAND_DIR, kv_get, kv_set, load_centroid  # noqa: E402
from email_alert import send_email  # noqa: E402

SHOWN_FILE = os.path.join(CAND_DIR, "cycle_shown.json")
RETRO_EVERY_CONFIRMS = 5
REJCHECK_EVERY_DAYS = 7
MIN_SHEET = 6
MINE_WINDOW_MIN = 45


def unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / (np.linalg.norm(v) + 1e-8)


def record_shown(ids):
    seen = []
    if os.path.exists(SHOWN_FILE):
        seen = json.load(open(SHOWN_FILE)).get("shown", [])
    merged = sorted(set(seen) | set(int(i) for i in ids))
    json.dump({"shown": merged, "updated": datetime.now(timezone.utc).isoformat()},
              open(SHOWN_FILE, "w"))
    return len(merged)


def rescore(con, cen):
    rows = con.execute("SELECT id, emb, status, special FROM candidates WHERE emb IS NOT NULL").fetchall()
    ups = [(float(unit(json.loads(emb)) @ cen), cid) for cid, emb, _, _ in rows]
    con.executemany("UPDATE candidates SET score=? WHERE id=?", ups)
    con.commit()
    sts = {cid: st for cid, _, st, _ in rows}
    spc = {cid: sp for cid, _, _, sp in rows}
    # TRAINING reals only drive the floor/bar decision: eval-only special positives (edge_positive)
    # are NOT in the centroid, so their out-of-sample score must not pose as the floor real and
    # trip the bar-drop logic (status='waymo' AND special IS NULL). They are also absent from `non`
    # below since that excludes all status='waymo'.
    reals = sorted((s, cid) for s, cid in ups if sts[cid] == "waymo" and spc[cid] is None)
    non = np.array(sorted(s for s, cid in ups if sts[cid] != "waymo"))
    n = len(non)
    print(f"rescored {len(rows)} | reals {reals[0][0]:.3f}-{reals[-1][0]:.3f} "
          f"(floor #{reals[0][1]}, next {' '.join(f'#{c} {s:.3f}' for s, c in reals[1:3])})")
    print(f"non-waymo n={n} p80 {non[int(n*0.8)]:.3f} p95 {non[int(n*0.95)]:.3f} "
          f"max {non[-1]:.3f} | >=0.92: {int((non>=0.92).sum())} >=0.93: {int((non>=0.93).sum())}")
    if reals[0][0] < PROB_TH:
        print(f"*** FLOOR REAL {reals[0][0]:.3f} BELOW PROB_TH {PROB_TH} — drop the bar and redeploy ***")


def rebucket(con):
    pro = con.execute("UPDATE candidates SET status='new' WHERE status='near' AND score>=?",
                      (PROB_TH,)).rowcount
    dem = con.execute("UPDATE candidates SET status='near' WHERE status='new' AND score<?",
                      (PROB_TH,)).rowcount
    con.commit()
    print(f"rebucket at {PROB_TH}: {pro} promoted, {dem} demoted")


def consolidated_email(con, ids):
    """Echo images for every confirm + ONE combined new-to-you sheet."""
    atts, lines, refs, windows = [], [], [], []
    for cid in ids:
        crop, frame, cam, cap = con.execute(
            "SELECT crop_path, frame_path, camera_id, captured_at FROM candidates WHERE id=?",
            (cid,)).fetchone()
        atts += [p for p in (crop, frame) if p and os.path.exists(p)]
        lines.append(f"<li><b>#{cid}</b> — {cam.replace('JamCams_', '')} @ {cap}</li>")
        refs.append(unit(json.loads(con.execute(
            "SELECT emb FROM candidates WHERE id=?", (cid,)).fetchone()[0])))
        t = datetime.fromisoformat(cap.replace("Z", ""))
        windows.append(((t - timedelta(minutes=MINE_WINDOW_MIN)).isoformat() + "Z",
                        (t + timedelta(minutes=MINE_WINDOW_MIN)).isoformat() + "Z"))

    # new-to-you: never-sent, in any confirm's window, ranked by max cosine to any confirm
    cand = {}
    for lo, hi in windows:
        for rid, emb, cp in con.execute(
                "SELECT id, emb, crop_path FROM candidates WHERE captured_at BETWEEN ? AND ? "
                "AND COALESCE(sent,0)=0 AND status NOT IN ('waymo','reject') AND emb IS NOT NULL",
                (lo, hi)):
            if rid not in cand:
                e = unit(json.loads(emb))
                cand[rid] = (max(float(e @ r) for r in refs), rid, cp)
    rows = sorted(cand.values(), reverse=True)[:72]

    shown = 0
    shown_ids = []
    sheet = os.path.join(CAND_DIR, "cycle_sheet.jpg")
    if len(rows) >= MIN_SHEET:
        shown = _build_sheet([(rid, s, cp) for s, rid, cp in rows], sheet, cap=72)
        if shown:
            atts.append(sheet)
            shown_ids = [rid for _, rid, _ in rows[:shown]]
    note = (f"<p>Below: <b>{shown}</b> never-before-sent candidates within "
            f"{MINE_WINDOW_MIN} min of the confirm(s), most-similar first. "
            f"Reply with the # of any real Waymo.</p>") if shown else \
           "<p>No unseen nearby candidates worth a sheet this time.</p>"
    html = ("<p><b>VERIFICATION</b> — the first attachments are the vehicle(s) you "
            "confirmed. If any is NOT a Waymo, reply \"undo #id\".</p>"
            f"<ul>{''.join(lines)}</ul>" + note)
    n = len(ids)
    ok = send_email(f"WaymoWatch: confirm cycle — {n} banked ({', '.join('#'+str(i) for i in ids)})"
                    f" — VERIFY first image(s)", html, attachments=atts)
    if ok and shown_ids:
        # mark shown/sent ONLY on a successful send (v0.8.22): a quota-failed email must
        # never record rows as user-reviewed — bank_shown would poison negatives unseen.
        con.execute("UPDATE candidates SET sent=1 WHERE id IN (%s)"
                    % ",".join(map(str, shown_ids)))
        con.commit()
        record_shown(shown_ids)
    elif not ok:
        print("SEND FAILED — nothing marked shown; re-run confirm_cycle to retry the email")
    print(f"consolidated email: {n} echo(s) + {shown}-row new-to-you sheet, sent={ok}")


def maybe_retro(con, force):
    confirms = con.execute("SELECT COUNT(*) FROM candidates WHERE status='waymo'").fetchone()[0]
    last = int(kv_get(con, "cycle:last_retro_confirms") or 0)
    if not force and confirms - last < RETRO_EVERY_CONFIRMS:
        print(f"retro skipped ({confirms - last}/{RETRO_EVERY_CONFIRMS} confirms since last)")
        return
    rows = con.execute("SELECT id, score, crop_path FROM candidates WHERE status NOT IN "
                       "('waymo','reject') ORDER BY score DESC LIMIT 200").fetchall()
    sheet = os.path.join(CAND_DIR, "retro.jpg")
    shown = _build_sheet(rows, sheet, cap=200)
    ok = send_email(f"WaymoWatch: top-200 retrospective at {confirms} reals "
                    f"({rows[0][1]:.3f}..{rows[-1][1]:.3f})",
                    "<p>Whole archive re-ranked on the current scale; top 200 unconfirmed. "
                    "Reply with the # of any real Waymo.</p>", attachments=[sheet])
    if not ok:
        print("retro SEND FAILED — nothing marked; trigger stays armed for next cycle")
        return
    con.execute("UPDATE candidates SET sent=1 WHERE id IN (%s)"
                % ",".join(str(r[0]) for r in rows[:shown]))
    con.commit()
    record_shown([r[0] for r in rows[:shown]])
    kv_set(con, "cycle:last_retro_confirms", str(confirms))
    con.commit()
    print(f"retro: {shown} rows, sent={ok}")


def maybe_rejcheck(con, force):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    last = kv_get(con, "cycle:last_rejcheck") or "1970-01-01"
    days = (datetime.fromisoformat(today) - datetime.fromisoformat(last)).days
    if not force and days < REJCHECK_EVERY_DAYS:
        print(f"rejects re-check skipped ({days}/{REJCHECK_EVERY_DAYS} days since last)")
        return
    rows = con.execute("SELECT id, score, crop_path FROM candidates WHERE status='reject' "
                       "ORDER BY score DESC LIMIT 100").fetchall()
    sheet = os.path.join(CAND_DIR, "rejcheck.jpg")
    shown = _build_sheet(rows, sheet, cap=100)
    ok = send_email(f"WaymoWatch: rejects re-check ({rows[0][1]:.3f}..{rows[-1][1]:.3f})",
                    "<p>Top-100 of the reject pool on the current scale — standing check for "
                    "bulk-verdict misses. Reply with the # of any real Waymo.</p>",
                    attachments=[sheet])
    if not ok:
        print("rejcheck SEND FAILED — trigger stays armed for next cycle")
        return
    kv_set(con, "cycle:last_rejcheck", today)
    con.commit()
    print(f"rejects re-check: {shown} rows, sent={ok}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", help="comma-separated confirm ids just banked")
    ap.add_argument("--force-retro", action="store_true",
                    help="send the retrospective regardless of trigger (use after bar changes)")
    ap.add_argument("--force-rejcheck", action="store_true")
    a = ap.parse_args()
    ids = [int(x) for x in a.ids.split(",") if x]
    con = dp.db_connect(dp.DEFAULT_DB)
    cen = load_centroid()
    rescore(con, cen)
    rebucket(con)
    consolidated_email(con, ids)
    maybe_retro(con, a.force_retro)
    maybe_rejcheck(con, a.force_rejcheck)


if __name__ == "__main__":
    main()
