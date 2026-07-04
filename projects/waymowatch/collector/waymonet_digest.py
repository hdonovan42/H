#!/usr/bin/env python3
"""WaymoNet review email — the human precision gate for the model's own candidates.

Emails the candidates WaymoNet flagged (wn_hit=1), ranked by model confidence, as FULL FRAMES with
the model's own detection box drawn in red — NEVER a crop. The bootstrap funnel's bbox only means
"a white vehicle is somewhere here", not which vehicle is the Waymo, so both review AND banking use
the model's box (wn_bbox) on the whole frame. Reply with the # of any real Waymo:
  --confirm IDS -> positives, captured as the full frame + the MODEL box (bbox set to wn_bbox)
  --reject  IDS -> hard_negatives (the frame is the negative background)

  waymonet_digest.py                 # send pending wn_hit candidates (>= --min, or --force)
  waymonet_digest.py --dry-run       # build the sheet, don't send/mark

Powered by TfL Open Data.
"""
import argparse
import json
import os
import shutil
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
REAL_DIR = os.path.join(BASE, "data", "real_positives")    # WaymoNet-path confirms -> positives
HARD_DIR = os.path.join(BASE, "data", "hard_negatives", "run2")   # RUN_2-era rejects kept SEPARATE from the
# RUN_1 hard negatives (data/hard_negatives/*): they're a different population — RUN_2's OWN false positives
# (its current blind spots), vs RUN_1's, which RUN_2 already mostly suppresses. build_real_dataset globs both.
AUTO_BANK_TH = 0.70   # RUN_3 recalibration (2026-07-04, threshold_report + human-adjudicated ceiling):
                      # confirmed-confuser ceiling = 0.638 (#100105); the tool's minimum-safe cut is 0.67
                      # but a NOVEL confuser once hit 0.67 (#40294, RUN_2 era), so 0.70 buys double margin
                      # for ~3% less hands-free. Banks ~76% of Waymos, 0 confirmed-confuser leaks.
                      # Anything below -> manual review. RE-DERIVE after every retrain or big hard-neg bank.


def _model_ver():
    """sha256[:12] of the DEPLOYED weights. Auto-bank acts ONLY on candidates scored by the current
    model — the 0.30 cut is model-specific, so a stale RUN_1 score (confusers reached 0.64) must never
    auto-bank."""
    import hashlib
    return hashlib.sha256(open(os.path.join(HERE, "best.pt"), "rb").read()).hexdigest()[:12]


def _build_frame_sheet(rows, out_path, cols=4, cap=MAX_CELLS):
    """Grid of FULL FRAMES with the model's box drawn red. rows = [(id, conf, box, frame_path), ...]
    (box = [x1,y1,x2,y2] or None). The whole scene is shown so a Waymo ANYWHERE in the frame is
    reviewable — never the funnel crop of one vehicle. Returns count shown."""
    cells = []
    for cid, sc, box, fp in rows[:cap]:
        im = cv2.imread(fp) if fp else None
        if im is None:
            continue
        c = im.copy()
        if box:
            x1, y1, x2, y2 = [max(0, int(round(v))) for v in box]
            cv2.rectangle(c, (x1, y1), (x2, y2), (0, 0, 255), 2)        # red = the model's box
        cv2.rectangle(c, (0, 0), (132, 20), (0, 0, 0), -1)
        cv2.putText(c, f"#{cid} {sc:.2f}", (3, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
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


def _ids(s):
    return [int(x) for x in s.replace(",", " ").split()]


def bank(con, ids, status, dest):
    """confirm -> positives captured at the MODEL box (wn_bbox: re-crop the frame there + set bbox);
    reject -> hard_negatives (the frame is the negative background). NEVER banks the funnel crop as a
    positive — that was the wrong vehicle."""
    os.makedirs(dest, exist_ok=True)
    n = 0
    for cid in ids:
        row = con.execute("SELECT crop_path, frame_path, wn_bbox FROM candidates WHERE id=?",
                          (cid,)).fetchone()
        if not row:
            print(f"  #{cid}: not found")
            continue
        cp, fp, wnb = row
        box = json.loads(wnb) if wnb else None
        if status == "waymo" and fp and os.path.exists(fp) and box:
            con.execute("UPDATE candidates SET status='waymo', special=NULL, bbox=? WHERE id=?",
                        (json.dumps([int(round(v)) for v in box]), cid))
            con.commit()      # short write txns: the loop is writing too — never hold the lock across file I/O
            img = cv2.imread(fp)
            x1, y1, x2, y2 = [max(0, int(round(v))) for v in box]
            crop = img[y1:y2, x1:x2]
            if crop.size > 0:
                cv2.imwrite(os.path.join(dest, os.path.basename(fp).replace("_frame.jpg", ".jpg")), crop)
            shutil.copy(fp, os.path.join(dest, os.path.basename(fp)))
        else:                                     # reject (or waymo w/o a model box) -> copy frame+crop
            con.execute("UPDATE candidates SET status=? WHERE id=?", (status, cid))
            con.commit()
            for p in (cp, fp):
                if p and os.path.exists(p):
                    shutil.copy(p, os.path.join(dest, os.path.basename(p)))
        n += 1
    con.commit()
    print(f"banked {n} -> {status}  ({dest})")


def auto_bank(con):
    """Bank every candidate the CURRENT model scores >= AUTO_BANK_TH as a positive so it goes LIVE on the
    public map straight away. This runs QUIETLY on every hourly digest tick, so a high-confidence Waymo
    appears within the hour instead of waiting for the daily run. No email here — the daily
    `autobank_review` digest (the user's existing 01:00 review) is the false-positive catch. Returns the
    number banked.

    Trade-off vs the old email-gated bank: rows now go on the map BEFORE the review email (a deliberate
    choice — the map should feel live). The "never un-reviewed" safety is preserved by autobank_review
    marking rows shown only on a delivered email and retrying otherwise, so nothing stays un-reviewed —
    it's just on the map first."""
    ver = _model_ver()
    ids = [r[0] for r in con.execute(
        "SELECT id FROM candidates "
        "WHERE COALESCE(wn_conf,0) >= ? AND status IN ('new','near') AND wn_model_ver = ? "
        "ORDER BY wn_conf DESC", (AUTO_BANK_TH, ver)).fetchall()]
    if not ids:
        print(f"auto-bank: nothing >= {AUTO_BANK_TH:.2f} (model {ver})")
        return 0
    bank(con, ids, "waymo", REAL_DIR)                 # status=waymo + frame & model-box crop -> positives
    con.execute("UPDATE candidates SET wn_autobank=1 WHERE id IN (%s)"
                % ",".join(str(int(i)) for i in ids))
    con.commit()
    print(f"auto-banked {len(ids)} -> waymo (model {ver}); LIVE on the map, 01:00 review pending")
    return len(ids)


def autobank_review(con):
    """The daily 01:00 auto-bank review — the user's EXISTING, liked digest, unchanged in purpose: email
    the Waymos auto-banked since the last review so a rare false positive can be undone. Only its SOURCE
    moved — banking now happens hourly (auto_bank), so this reviews the wn_autobank rows not yet shown
    rather than banking them itself. Marks a row reviewed only on a DELIVERED email, so a failed send
    (Resend outage) simply retries next run — no auto-bank ever goes permanently un-reviewed."""
    rows = con.execute(
        "SELECT id, wn_conf, wn_bbox, frame_path FROM candidates "
        "WHERE COALESCE(wn_autobank,0)=1 AND COALESCE(wn_autobank_sent,0)=0 AND status='waymo' "
        "ORDER BY wn_conf DESC").fetchall()
    if not rows:
        print("autobank-review: nothing new to review")
        return
    data = [(r[0], r[1] or 0.0, json.loads(r[2]) if r[2] else None, r[3]) for r in rows]
    sheet = os.path.join(BASE, "data/candidates/autobank.jpg")
    n = _build_frame_sheet(data, sheet, cap=len(data))
    lo, hi = rows[-1][1], rows[0][1]
    ok = send_email(
        f"WaymoWatch: {n} auto-banked as Waymos (conf {lo:.2f}–{hi:.2f}) — reply 'undo #id' if any is NOT a Waymo",
        f"<p><b>WaymoNet</b> auto-banked these <b>{n}</b> candidate(s) <b>&ge;{AUTO_BANK_TH:.2f}</b> — above "
        f"every confirmed non-Waymo — so they were <b>auto-banked as Waymos</b> and have been <b>live on "
        f"the map</b> since. Full frame, model box in <b>red</b>, #id + conf (highest first).</p><p>Reply "
        f"<b>undo #id</b> for any that is <b>not</b> a Waymo and I'll move it back out of the positives.</p>"
        f"<p style='color:#888'>Powered by TfL Open Data.</p>", attachments=[sheet])
    if not ok:
        print(f"autobank-review: email FAILED — leaving {n} unmarked; next run retries")
        return
    con.execute("UPDATE candidates SET wn_autobank_sent=1 WHERE id IN (%s)"
                % ",".join(str(int(r[0])) for r in rows))
    con.commit()
    print(f"autobank-review: emailed {n}, marked reviewed")


def audit(con):
    """SELF-HEAL + ALARM against silent score/frame desync (the bug that scored real Waymos 0 and
    dropped them). A score is STALE if the frame file was written AFTER the score was taken
    (mtime > wn_scored_at) — the live take-max keeps these in sync, so in normal operation this finds
    ~nothing; it fires only when the binding breaks. Stale candidates are re-scored on the CURRENT
    frame, and if any re-score as a Waymo we EMAIL an alarm — a silent drop becomes loud."""
    import hashlib
    import time
    from live_capture import wn_safe                     # torch-heavy: imported only when auditing

    def to_unix(iso):
        try:
            return time.mktime(time.strptime((iso or "").replace("Z", ""), "%Y-%m-%dT%H:%M:%S"))
        except (ValueError, TypeError):
            return 0.0

    stale = []
    for cid, fp, sa in con.execute("SELECT id, frame_path, wn_scored_at FROM candidates "
                                   "WHERE status IN ('new','near') AND frame_path IS NOT NULL"):
        # need a KNOWN score time to judge staleness — NULL wn_scored_at = unbound backlog (frame
        # unchanged so the score is still valid; it self-binds when the loop next touches it). 120 s slack
        # so within-cycle write->score latency (a few s) is never mistaken for real desync, which is
        # minutes-to-hours (a frame overwritten long after its score was taken).
        if fp and sa and os.path.exists(fp) and os.path.getmtime(fp) > to_unix(sa) + 120:
            stale.append((cid, fp))
    if len(stale) > 2000:                              # normal daily count is ~0; this = a systemic break
        send_email(f"WaymoNet AUDIT: {len(stale)} stale scores — systemic desync, NOT auto-re-scoring",
                   f"<p>The self-audit found <b>{len(stale)}</b> candidates whose frame changed well after "
                   f"they were scored — far above the normal ~0, signalling a systemic binding break (e.g. a "
                   f"bulk score load). NOT auto-re-scoring, to avoid masking it. Investigate.</p>")
        print(f"audit: {len(stale)} stale ABOVE CAP — alarmed, not auto-re-scoring")
        return len(stale), 0
    recovered = []
    for cid, fp in stale:
        try:
            b = open(fp, "rb").read()
            sha = hashlib.sha256(b).hexdigest()
            im = cv2.imdecode(np.frombuffer(b, np.uint8), cv2.IMREAD_COLOR)
            wc, wb, _ = wn_safe(im)
        except Exception:
            continue
        old = con.execute("SELECT COALESCE(wn_conf,0) FROM candidates WHERE id=?", (cid,)).fetchone()[0]
        con.execute("UPDATE candidates SET wn_conf=?, wn_bbox=?, wn_hit=?, wn_scored=1, wn_scored_at=?, "
                    "wn_frame_sha=?, frame_sha=? WHERE id=?",
                    (round(wc, 4), json.dumps(wb) if wb else None, 1 if wc >= 0.03 else 0,
                     time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), sha, sha, cid))
        con.commit()   # per-row: each re-score is ~0.35 s — one txn across the sweep starved the
        # loop's writes for minutes and bloated the WAL (the 2026-06-27 two-day stall)
        if wc >= 0.10 and old < 0.10:
            recovered.append((cid, round(wc, 3)))
    con.commit()
    print(f"audit: {len(stale)} stale (frame newer than score) re-scored; {len(recovered)} recovered >= 0.10")
    if recovered:
        recovered.sort(key=lambda x: -x[1])
        send_email(
            f"WaymoNet AUDIT ALARM: {len(recovered)} stale-scored Waymo(s) recovered",
            "<p><b>WaymoNet self-audit</b> found candidates whose stored score was <b>STALE</b> (frame "
            f"changed after scoring) and that re-score as a Waymo (&ge;0.10) — they were at risk of being "
            f"<b>silently missed</b>. Re-scored and back in the review pool:</p><ul>"
            + "".join(f"<li>#{c} — {v}</li>" for c, v in recovered[:60])
            + "</ul><p style='color:#888'>Powered by TfL Open Data.</p>")
    return len(stale), len(recovered)


def _alarm(marker_name, subject, html, throttle_h=3.0):
    """Throttled alarm email. The throttle marker is written ONLY on a confirmed send — a
    quota-failed alarm must not silence itself for the next 3 h (the old stall alarm did)."""
    import time
    marker = os.path.join(BASE, "data", marker_name)
    if os.path.exists(marker) and time.time() - os.path.getmtime(marker) < throttle_h * 3600:
        print(f"alarm throttled ({marker_name}): {subject}")
        return
    if send_email(subject, html):
        open(marker, "w").write(subject)
        print(f"ALARM emailed: {subject}")
    else:
        print(f"ALARM send FAILED (will retry next run): {subject}")


def check_loop_health(con):
    """LOUD alarms for the two silent failure modes, run on every cron invocation (:17 / 00:00 / 04:00).
    1) STALLED capture: the loop can be 'alive' (process up, cycling) yet fail to persist anything for
       days — e.g. a DB lock — with no signal; that is how 2 days of captures were lost.
    2) SCORING blackout: wn_safe swallows every failure (rows land wn_scored=0, wn_hit=0), so a
       persistent break (corrupt best.pt, ultralytics error) means candidates keep flowing but NONE
       reach the digest or auto-bank — capture-health stays green while detection is fully dark."""
    import time
    STALL_HOURS = 2.0
    row = con.execute("SELECT MAX(captured_at) FROM candidates").fetchone()
    latest = row[0] if row and row[0] else None
    if latest:
        try:
            age_h = (time.time() - time.mktime(time.strptime(
                latest.replace("Z", "").split(".")[0], "%Y-%m-%dT%H:%M:%S"))) / 3600.0
        except (ValueError, TypeError):
            age_h = None
        if age_h is not None and age_h >= STALL_HOURS:
            _alarm(".stall_alarm",
                   f"WaymoWatch LOOP STALL — no new captures in {age_h:.1f} h",
                   f"<p><b>The capture loop has not persisted a candidate in {age_h:.1f} hours</b> "
                   f"(newest: {latest}). It may be dead or alive-but-unable-to-WRITE ('database is "
                   f"locked'/WAL bloat). On the VPS: tail <code>data/candidates/capture.log</code>; "
                   f"restart with <code>ssh root@vps-hel1 systemctl restart waymowatch-loop</code>; "
                   f"checkpoint the WAL if bloated.</p>"
                   f"<p style='color:#888'>Powered by TfL Open Data.</p>")
    SCORE_FAIL_HOURS, SCORE_FAIL_MIN = 2.0, 10
    cut = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - SCORE_FAIL_HOURS * 3600))
    n_fail = con.execute("SELECT COUNT(*) FROM candidates WHERE captured_at >= ? "
                         "AND COALESCE(wn_scored,0)=0", (cut,)).fetchone()[0]
    if n_fail >= SCORE_FAIL_MIN:
        _alarm(".scoring_alarm",
               f"WaymoWatch SCORING FAILURE — {n_fail} unscored candidates in the last {SCORE_FAIL_HOURS:.0f} h",
               f"<p><b>{n_fail}</b> candidates captured in the last {SCORE_FAIL_HOURS:.0f} h have "
               f"<b>wn_scored=0</b> — in-process WaymoNet scoring is failing, so they are invisible "
               f"to the review digest AND auto-bank. Check <code>capture.log</code> for "
               f"'[wn] score error' lines and that <code>collector/best.pt</code> is intact. "
               f"Unscored rows are exempt from retention (nothing is lost) but stay dark until "
               f"re-scored after the fix.</p>"
               f"<p style='color:#888'>Powered by TfL Open Data.</p>")


def main():
    ap = argparse.ArgumentParser(description="Email WaymoNet's flagged candidates (full frame) for review.")
    ap.add_argument("--limit", type=int, default=MAX_CELLS)
    ap.add_argument("--min", type=int, default=10, dest="min_pile",
                    help="only send once at least this many unsent flagged candidates have piled up")
    ap.add_argument("--force", action="store_true", help="send now regardless of --min")
    ap.add_argument("--dry-run", action="store_true", help="build the sheet but don't send or mark")
    ap.add_argument("--confirm", default="", help="ids -> waymo (frame + model box) in real_positives/")
    ap.add_argument("--reject", default="", help="ids -> reject, copied to data/hard_negatives/")
    ap.add_argument("--reject-rest", action="store_true",
                    help="reject ALL reviewed-but-unconfirmed (wn_sent=1, still 'new') -> hard_negatives")
    ap.add_argument("--auto-bank", action="store_true",
                    help=f"bank everything the current model scores >= {AUTO_BANK_TH} as a positive (quiet; also runs hourly)")
    ap.add_argument("--autobank-review", action="store_true",
                    help="daily 01:00 review: email the day's auto-banks for undo (retries until delivered)")
    ap.add_argument("--audit", action="store_true",
                    help="self-heal: re-score candidates whose frame changed after scoring; alarm on recovered Waymos")
    a = ap.parse_args()

    con = sqlite3.connect(DB, timeout=120)
    try:
        con.execute("ALTER TABLE candidates ADD COLUMN wn_autobank INTEGER DEFAULT 0")
        con.commit()
    except sqlite3.OperationalError:
        pass
    try:
        con.execute("ALTER TABLE candidates ADD COLUMN wn_autobank_sent INTEGER DEFAULT 0")
        con.execute("UPDATE candidates SET wn_autobank_sent=1 WHERE COALESCE(wn_autobank,0)=1")  # existing autobanks already reviewed at their 01:00 run
        con.commit()
    except sqlite3.OperationalError:
        pass
    try:
        check_loop_health(con)          # runs on every invocation (:17 / auto-bank / audit) — stall alarm
    except Exception as e:
        print(f"loop-health check failed: {e}")
    if a.audit:
        audit(con)
        return
    if a.auto_bank:
        auto_bank(con)
        return
    if a.autobank_review:
        autobank_review(con)
        return
    if a.confirm:
        bank(con, _ids(a.confirm), "waymo", REAL_DIR)
        return
    if a.reject:
        bank(con, _ids(a.reject), "reject", HARD_DIR)
        return
    if a.reject_rest:
        rest = [r[0] for r in con.execute(
            "SELECT id FROM candidates WHERE wn_sent=1 AND status='new'").fetchall()]
        print(f"reject-rest: {len(rest)} reviewed-but-unconfirmed -> hard_negatives")
        bank(con, rest, "reject", HARD_DIR)
        return
    if not a.dry_run:
        auto_bank(con)     # hourly tick: bank >= TH QUIETLY so the map is <=1 h fresh; the < TH rest -> review below
    rows = con.execute(
        "SELECT id, wn_conf, wn_bbox, frame_path FROM candidates "
        "WHERE wn_hit=1 AND COALESCE(wn_sent,0)=0 AND status NOT IN ('waymo','reject') "
        "AND COALESCE(wn_conf,0) < ? "          # >= AUTO_BANK_TH auto-banks instead (no manual review)
        "ORDER BY wn_conf DESC LIMIT ?", (AUTO_BANK_TH, a.limit)).fetchall()
    if not rows:
        print("no unsent WaymoNet-flagged candidates")
        return
    if len(rows) < a.min_pile and not a.force and not a.dry_run:
        print(f"only {len(rows)} flagged (< {a.min_pile}) — holding until {a.min_pile} pile up")
        return

    sheet_rows = [(r[0], r[1], json.loads(r[2]) if r[2] else None, r[3]) for r in rows]
    sheet = os.path.join(BASE, "data/candidates/waymonet_review.jpg")
    shown = _build_frame_sheet(sheet_rows, sheet, cap=len(sheet_rows))
    lo, hi = rows[-1][1], rows[0][1]
    subj = f"WaymoWatch: WaymoNet flagged {shown} candidate(s) — FULL FRAMES (conf {lo:.2f}–{hi:.2f})"
    # running tally of review volume (user-requested 2026-07-04): per-send log -> daily totals
    con.execute("CREATE TABLE IF NOT EXISTS sent_log(sent_at TEXT, n INTEGER)")
    today_prev = con.execute("SELECT COALESCE(SUM(n),0) FROM sent_log "
                             "WHERE date(sent_at)=date('now')").fetchone()[0]
    avg7 = con.execute("SELECT COALESCE(SUM(n),0)/7.0 FROM sent_log "
                       "WHERE sent_at >= datetime('now','-7 days')").fetchone()[0]
    html = (
        f"<p><b>WaymoNet</b> flagged these <b>{shown}</b> candidate(s) (conf &ge; 0.03), highest first. "
        f"Each cell is the <b>FULL FRAME</b> with the model's box drawn in <b>red</b> and labelled "
        f"#id + conf — so you see the whole scene and exactly what the model detected, never a crop.</p>"
        f"<p>Reply with the <b>#</b> of any frame with a real Waymo (white Jaguar I-PACE, dark roof "
        f"dome). Everything you don't flag becomes a hard negative — the model curates its own dataset.</p>"
        f"<p style='color:#888'>Review tally: <b>{today_prev + shown}</b> sent today · "
        f"7-day avg {avg7:.0f}/day.</p>"
        f"<p style='color:#888'>Powered by TfL Open Data.</p>")

    if a.dry_run:
        print(f"[dry-run] {shown} full-frame candidate(s), conf {lo:.2f}–{hi:.2f} -> {sheet} (not sent)")
        return
    if shown and send_email(subj, html, attachments=[sheet]):
        ids = [r[0] for r in rows]
        con.execute("UPDATE candidates SET wn_sent=1 WHERE id IN (%s)"
                    % ",".join(str(int(i)) for i in ids))
        con.execute("INSERT INTO sent_log VALUES(strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)", (shown,))
        con.commit()
        print(f"sent {shown} candidate(s) for review; tally today: {today_prev + shown}")
    else:
        print("send failed or nothing to show — leaving wn_sent=0 for retry")


if __name__ == "__main__":
    main()
