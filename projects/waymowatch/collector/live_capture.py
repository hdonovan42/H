#!/usr/bin/env python3
"""WaymoWatch live capture loop — surface real Waymo candidates from the live JamCam feed.

The only perfectly on-distribution data source: real Waymos on real cameras at the real
elevated angle/scale. Bootstraps before a good detector exists with a no-GPU, no-API surfacer:
  poll TfL -> decode each clip -> sample frames -> generic car detector -> roof crop ->
  cosine similarity to our 39 real dome templates -> store anything roof-structure-ish as a
  CANDIDATE for human review. You confirm; confirmed crops become gold real positives.

Modes:
  --loop            24/7 zone watcher (v0.5): threaded ETag poll of ALL ~480 Waymo-zone cams
                    every POLL_EVERY s (below TfL's min refresh -> nothing skipped), tiered
                    queues (spine first, never dropped), per-cycle coverage telemetry
  (default)         one serial sweep over the FOCUS cameras, then rebuild the review sheet
  --confirm 3,7     promote candidate ids -> data/real_positives/ (status=waymo)
  --reject 4,5      mark candidate ids rejected
  --review          just rebuild the review contact sheet

Run on a schedule (cron/systemd, every ~10 min) to accumulate real data 24/7. CPU-only.
"""
import argparse
import glob
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(BASE, "dataset"))
import data_plane as dp  # noqa: E402
from separability_eval import build_embedder, jamcam  # noqa: E402

# Waymo operating-zone box (v0.8, 2026-06-10): Park Royal depot in the west, extended EAST
# past the old -0.02 cut (3 of the first 12 confirms hugged that edge — #3310 A2 New Cross
# 0.009 deg from it; the A2 + Limehouse corridors continue east) to cover Greenwich /
# Lewisham A21 / Canary Wharf. ~608 available cams — ALL tier-2 watch targets; SPINE stays
# tier-1 (never dropped). Cycle headroom is real: measured per-cam refresh floor is 267s
# (EMA n=507), so ~190s projected cycles still skip nothing.
ZONE = dict(lat0=51.42, lat1=51.58, lon0=-0.36, lon1=0.06)
# Manual detection phase: King's Cross / British Library / Euston Rd corridor only
# (user's highest-density Waymo-sighting area) — max hit-rate, min wasted compute.
FOCUS = {
    "00001.07356",  # Euston Rd / Grays Inn Rd   (British Library corner)
    "00001.07358",  # A501 W of Mabledon Place    (Euston Rd / St Pancras)
    "00001.09630",  # Caledonian Rd / Caledonia St (King's Cross station)
    "00001.03591",  # Kings X Rd / Swinton St
    "00001.03590",  # Kings X Rd / Wharton St
    "00001.09640",  # Grays Inn Rd / Acton St
    "00001.07360",  # A501 East of Melton St      (Euston Rd)
    "00001.07355",  # Pentonville Road / Penton Rise
}
TOPK_PER_CAM = 3      # (legacy; superseded by per-vehicle dedup below)
SCORE_FLOOR = 0.50
DEDUP_TH = 0.93       # cosine >= this => same vehicle: one entry, crop updated to the best view
KX_CENTRE = (51.5310, -0.1255)   # King's Cross / British Library centre (for --collect area)
PARK_ROYAL = (51.5235, -0.2830)  # Waymo's London depot (NW10) — cars start/end runs here; the
                                 # ring of cams covers the depot + its arterials (A40, A406, Hanger Ln)
# Depot->city SPINE (2026-06-09): every run starts/ends at Park Royal, and the A40/Westway ->
# Marylebone Rd -> Euston Rd corridor is the natural path to central London (user-confirmed
# sightings: Euston Rd). Cover the spine end-to-end, densest at the sighting hotspot.
SPINE = [
    (PARK_ROYAL, 22),            # depot + A40 / A406 / Hanger Lane
    ((51.5208, -0.2050), 18),    # Westway / Royal Oak / Paddington approaches
    ((51.5226, -0.1571), 20),    # Marylebone Rd / Baker St
    (KX_CENTRE, 60),             # Euston Rd / King's Cross / St Pancras
]
POLL_EVERY = 150      # seconds between full conditional-GET passes over the watchlist. Must stay
                      # BELOW TfL's minimum refresh (~180s): a cam can then never publish two clips
                      # between our polls, so ETag polling at this cadence misses NOTHING.
POLL_THREADS = 12     # concurrent conditional GETs (pure I/O; ~480 cams in ~10s)
MAX_BACKLOG = 400     # tier-2 (zone) clip queue cap; overflow drops OLDEST zone clips (spine is
                      # tier-1 and never dropped). Drops are counted + reported — never silent.
VID_STRIDE = 5        # frame stride for det.track (was 3): 25fps clip -> 5 sampled fps; a passing
                      # car is in view 2-4s = 10-20 samples, plenty for ByteTrack. 1.67x cheaper.
PROB_TH = 0.80        # digest ELIGIBILITY bar — 31-REAL scale (v0.8.10, 2026-06-11 afternoon):
                      # live archive n=9,037 p80 0.849 / p95 0.873 / max 0.920; reals 0.816-0.914
                      # (floor slid 0.819->0.816, margin over the old 0.81 bar down to 0.006 ->
                      # dropped a notch, margin now 0.016). Set just BELOW the weakest real view —
                      # recall-first: eligibility must cover every known-real strength; DAY_CAP
                      # (4000) governs what is actually sent.
DAY_CAP = 10000       # max candidate cells emailed per day (50 pages of PAGE_SIZE) — the user's review
                      # budget IS the constant; the score cut adapts. Unsent overflow is demoted to the
                      # near archive at end of day (retrievable, minable — never silently destroyed).
NEAR_TH = 0.76        # archive floor — the ONLY irrecoverable cut in the funnel (below it a
                      # vehicle is discarded forever; above it, re-seeds re-rank from stored embs).
                      # Widened 0.80->0.76 (v0.8): hardest real view #2145 CAPTURED at 0.813, only
                      # 0.013 over the old floor, and the real floor drops with each harder view.
                      # Disk is a non-issue (7-day prune). NEAR_KEEP_DAYS prune.
NEAR_KEEP_DAYS = 7    # near rows + their jpgs are pruned after this many days (mine promptly)
ALERT_TH = 0.93       # instant-alert bar (31-real scale): one FP reached 0.920, breaking the old
                      # 0.92 bar -> raised. Above ALL 9,037 known FPs (max 0.920); top real 0.914 —
                      # alerts are the PRECISION channel, ranked sheets the recall channel.
BATCH_SIZE = 5        # (legacy count-trigger; superseded by PAGE_SIZE paging below)
PAGE_SIZE = 200       # digest paging: the moment this many candidates pile up during the day, email
                      # that full page right away and reset; the remainder (< PAGE_SIZE) goes at
                      # DIGEST_HOUR. e.g. 456/day -> 200 + 200 + 56 across 3 emails. Overflow never lost.
COLLECT_HOURS = (0, 24)  # 24/7 (2026-06-09): Waymo runs at night too and overnight CPU is idle —
                         # the site's job is to find them, so it never stops looking.
DIGEST_HOUR = 23         # ONE digest/day at 23:00 London; overnight candidates roll into the next
                         # day's pages (paging guarantees nothing is ever lost).
CAND_DIR = os.path.join(BASE, "data", "candidates")
REAL_DIR = os.path.join(BASE, "data", "real_positives")
SAMPLE_EVERY = 8       # ~3 fps — enough chances to catch a pass, light on CPU
MIN_H = 44             # host vehicle must be near/mid field (dome resolvable)
SCORE_THRESH = 0.80    # cosine to dome centroid — wide net; humans filter


def ensure_schema(con):
    con.executescript("""
    CREATE TABLE IF NOT EXISTS candidates(
      id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT, captured_at TEXT,
      score REAL, crop_path TEXT, frame_path TEXT, status TEXT DEFAULT 'new', emb TEXT, bbox TEXT,
      alerted INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_cand_status ON candidates(status);
    CREATE INDEX IF NOT EXISTS idx_cand_cam ON candidates(camera_id);
    CREATE TABLE IF NOT EXISTS cycles(
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, secs REAL,
      polled INTEGER, fresh INTEGER, processed INTEGER, dropped INTEGER,
      spine_fresh INTEGER, spine_processed INTEGER, new_cands INTEGER, near_cands INTEGER);""")
    for col in ("emb TEXT", "bbox TEXT", "alerted INTEGER DEFAULT 0",
                "sent INTEGER DEFAULT 0"):   # for pre-existing tables
        try:
            con.execute(f"ALTER TABLE candidates ADD COLUMN {col}")
        except Exception:
            pass


# Roof-crop geometry (TIGHT, 2026-06-09): top ~22% of the vehicle bbox, 28% side inset.
# The old 45%/16% crop buried the dome in car/scene context — adding a dome moved the
# cosine score only +0.016 (dataset/recall_eval.py: end-to-end recall 2.5% @ 0.82, the
# 4 silent days explained). At 22%/28% the dome dominates the embedded image:
# pasted-vs-unpasted ROC-AUC 0.614 -> 0.839 (camera-split, dataset/reseed_centroid_eval.py).
ROOF_TOP, ROOF_BOTTOM, ROOF_INSET = -0.06, 0.22, 0.28
CENTROID_FILE = os.path.join(HERE, "dome_centroid_tight.json")


def roof_crop(frm, bbox):
    """The live roof crop — single source of truth, shared with the eval scripts."""
    x1, y1, x2, y2 = bbox
    mx = int((x2 - x1) * ROOF_INSET)
    return frm[max(0, int(y1 + (y2 - y1) * ROOF_TOP)):int(y1 + (y2 - y1) * ROOF_BOTTOM),
               max(0, x1 + mx):min(frm.shape[1], x2 - mx)]


def load_centroid():
    """Deployed surfacer centroid: mean MobileNetV3 embedding of SYNTHETIC Waymo roof crops
    (real dome pasted on real white JamCam hosts, tight geometry) — built by
    dataset/export_centroid.py, committed as dome_centroid_tight.json. The old centroid
    (raw close-up dome photos) didn't transfer to in-frame roof crops. Re-seed from real
    CCTV domes once confirmed positives land."""
    c = np.array(json.load(open(CENTROID_FILE))["centroid"], dtype=np.float32)
    return c / (np.linalg.norm(c) + 1e-8)


def in_zone(c):
    return (c.get("lat") and ZONE["lat0"] <= c["lat"] <= ZONE["lat1"]
            and ZONE["lon0"] <= c["lon"] <= ZONE["lon1"])


def in_collection_window():
    """True if it's within the daytime collection window in London local time (BST/GMT auto)."""
    h = datetime.now(ZoneInfo("Europe/London")).hour
    return COLLECT_HOURS[0] <= h < COLLECT_HOURS[1]


def nearest_short_ids(cams, k, centre=KX_CENTRE):
    avail = [c for c in cams if dp.props(c).get("available") == "true"
             and dp.props(c).get("videoUrl") and c.get("lat")]
    avail.sort(key=lambda c: (c["lat"] - centre[0]) ** 2 + (c["lon"] - centre[1]) ** 2)
    return {c["id"].replace("JamCams_", "") for c in avail[:k]}


def spine_focus(cams):
    """Union of the SPINE clusters — the depot->city corridor, ~110-120 cams after overlap."""
    foc = set()
    for centre, k in SPINE:
        foc |= nearest_short_ids(cams, k, centre)
    return foc


def kv_get(con, key):
    row = con.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return row[0] if row else None


def kv_set(con, key, value):
    con.execute("INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)", (key, value))


def ts():
    return datetime.now(ZoneInfo("Europe/London")).strftime("%H:%M:%S")


def detector():
    """Live YOLO detector — prefers the committed OpenVINO INT8 export (calibrated on our own
    JamCam frames; 2.7x vs torch with VID_STRIDE=5 on the 2-vCPU VPS, measured 2026-06-10)."""
    from ultralytics import YOLO
    p = os.path.join(HERE, "models", "yolo11n_int8_openvino_model")
    return YOLO(p if os.path.isdir(p) else "yolo11n.pt", task="detect")


def zone_watchlist(cams):
    """The v0.5 watch set. Tier-1 = depot->KX spine (processed first, never dropped);
    tier-2 = every other available cam inside the Waymo operating-zone box (~480 total).
    Returns (tier1_ids, tier2_ids, {short_id: cam})."""
    avail = [c for c in cams if dp.props(c).get("available") == "true"
             and dp.props(c).get("videoUrl") and c.get("lat")]
    idx = {c["id"].replace("JamCams_", ""): c for c in avail}
    t1 = spine_focus(cams) & set(idx)
    t2 = {sid for sid, c in idx.items() if in_zone(c)} - t1
    return t1, t2, idx


def poll_cams(con, cam_index, ids):
    """One conditional-GET pass over the watchlist (threaded, pure HTTP — workers never touch
    the DB). Returns [(short_id, clip_bytes_or_None, etag)]; None body = 304/error."""
    etags = {sid: kv_get(con, f"etag:{sid}") for sid in ids}

    def one(sid):
        try:
            st, body, hdrs = dp.http_get(dp.props(cam_index[sid]).get("videoUrl"),
                                         etag=etags.get(sid), retries=1)
            et = (hdrs.get("ETag") or "").strip() if hdrs else ""
            return sid, (None if st == 304 else body), et
        except Exception:
            return sid, None, ""

    with ThreadPoolExecutor(POLL_THREADS) as ex:
        return list(ex.map(one, ids))


def note_refresh(con, sid, now_t):
    """Learn each camera's clip-refresh period (EMA over observed ETag-change intervals) —
    powers the 'est. published clips' coverage denominator in the daily digest."""
    last = kv_get(con, f"chg:{sid}")
    if last:
        iv = now_t - float(last)
        if 60 <= iv <= 1800:
            prev = kv_get(con, f"per:{sid}")
            per = 0.7 * float(prev) + 0.3 * iv if prev else iv
            kv_set(con, f"per:{sid}", str(round(per, 1)))
    kv_set(con, f"chg:{sid}", str(round(now_t, 1)))


def coverage_line(con, hours=24):
    """Honest coverage statement for the digest: clips processed vs fetched vs an estimate of
    what TfL actually published (sum of window/learned-period over watched cams)."""
    cut = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - hours * 3600))
    fresh, proc, drop = con.execute(
        "SELECT COALESCE(SUM(fresh),0), COALESCE(SUM(processed),0), COALESCE(SUM(dropped),0) "
        "FROM cycles WHERE started_at >= ?", (cut,)).fetchone()
    if not fresh:
        return ""
    exp = 0.0
    for (v,) in con.execute("SELECT value FROM kv WHERE key LIKE 'per:%'"):
        try:
            exp += hours * 3600 / max(120.0, float(v))
        except Exception:
            pass
    est = f", ~{min(100.0, proc / exp * 100):.0f}% of est. {int(exp):,} published" if exp else ""
    return (f"Coverage last {hours}h: {proc:,}/{fresh:,} fetched clips processed"
            f" ({drop} dropped){est}.")


def is_white(car):
    """Stage-1 cheap colour filter: Waymos are (predominantly) white. Lenient on brightness — also
    passes silver/off-white and white-in-shadow so we don't miss a Waymo; white vans/cabs pass too
    (the hard negatives Stage 2 needs). The mean-saturation gate discards genuinely coloured cars
    (red/blue/orange); muted-green and grey/silver are as desaturated as white and CANNOT be split
    here — that's the dome classifier's job. Validated: rejects bright-coloured leaks, passes ~96%
    of 225 real white crops (vs 98% without the gate)."""
    if car is None or car.size == 0:
        return False
    h, w = car.shape[:2]
    c = car[int(h * 0.20):int(h * 0.85), int(w * 0.20):int(w * 0.80)]  # central body, skip road/edges
    if c.size == 0:
        return False
    hsv = cv2.cvtColor(c, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2].astype(np.float32) / 255.0
    s = hsv[:, :, 1].astype(np.float32) / 255.0
    whiteish = ((v > 0.55) & (s < 0.28)).mean()      # bright + desaturated body panels
    return whiteish > 0.30 and float(s.mean()) < 0.24  # + colour gate: reject saturated (coloured) cars


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def scan_clip(det, path):
    """Within-clip ByteTrack pass: collapse each moving car (many frames) into ONE track and
    keep its biggest (closest) white, resolvable view. Returns {track_id: (area, frame, bbox)}."""
    best = {}
    for r in det.track(path, persist=False, tracker="bytetrack.yaml", classes=[2],
                       conf=0.30, imgsz=352, vid_stride=VID_STRIDE, stream=True, verbose=False):
        fr = r.orig_img
        if r.boxes is None or r.boxes.id is None:
            continue
        for b in r.boxes:
            x1, y1, x2, y2 = map(int, b.xyxy[0].tolist())
            if (y2 - y1) < MIN_H:
                continue
            if not is_white(fr[max(0, y1):y2, max(0, x1):x2]):
                continue
            tid = int(b.id[0])
            area = (x2 - x1) * (y2 - y1)
            if tid not in best or area > best[tid][0]:
                best[tid] = (area, fr.copy(), (x1, y1, x2, y2))
    return best


def ingest(con, embed, cen, cam_id, best):
    """Score each track's best view, dedup against this camera's recent candidates, and
    insert/update rows + jpgs. Returns (new, near) counts. Caller commits."""
    short = cam_id.replace("JamCams_", "")
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    stamp = now.replace("-", "").replace(":", "").replace("T", "").replace("Z", "")
    found, near = 0, 0
    # recent entries at this camera, for cross-sweep dedup (parked cars = same bbox spot)
    recent = [[rid, rsc, np.array(json.loads(remb)), st, (json.loads(bb) if bb else None)]
              for rid, rsc, remb, st, bb in con.execute(
                  "SELECT id,score,emb,status,bbox FROM candidates WHERE camera_id=? "
                  "ORDER BY id DESC LIMIT 400", (cam_id,)).fetchall() if remb]
    for tid, (area, frm, bbox) in best.items():
        x1, y1, x2, y2 = bbox
        roof = roof_crop(frm, bbox)
        if roof.size == 0 or min(roof.shape[:2]) < 6:
            continue
        e = embed(jamcam(roof))
        s = float(e @ cen)
        if s < NEAR_TH:
            continue  # below even the near-miss band; discard
        status = "new" if s >= PROB_TH else "near"        # near = silent archive
        hd = int((y2 - y1) * 0.12)
        car = frm[max(0, y1 - hd):y2, max(0, x1):min(frm.shape[1], x2)]
        # same vehicle if same parked spot (bbox IoU) OR near-identical appearance
        m = next((c for c in recent if (c[4] and iou(bbox, c[4]) > 0.45)
                  or float(e @ c[2]) >= DEDUP_TH), None)
        cp = os.path.join(CAND_DIR, f"{short}_t{tid}_{stamp}.jpg")
        fpth = os.path.join(CAND_DIR, f"{short}_t{tid}_{stamp}_frame.jpg")
        if m:
            promote = m[3] == "near" and status == "new"  # near vehicle crossed the digest bar
            if m[3] in ("new", "near") and (s > m[1] + 0.01 or promote):  # better view -> update
                old = con.execute("SELECT crop_path,frame_path FROM candidates WHERE id=?", (m[0],)).fetchone()
                cv2.imwrite(cp, car); cv2.imwrite(fpth, frm)
                con.execute("UPDATE candidates SET score=?,crop_path=?,frame_path=?,emb=?,bbox=?,"
                            "captured_at=?,status=? WHERE id=?",
                            (s, cp, fpth, json.dumps([round(float(x), 4) for x in e]),
                             json.dumps(list(bbox)), now, "new" if promote else m[3], m[0]))
                for f in (old or []):
                    if f and f not in (cp, fpth) and os.path.exists(f):
                        try:
                            os.remove(f)
                        except Exception:
                            pass
                m[1], m[2], m[4] = s, e, list(bbox)
                if promote:
                    m[3] = "new"
                    found += 1
            continue                                      # same vehicle -> no new row
        cv2.imwrite(cp, car); cv2.imwrite(fpth, frm)
        cur = con.execute("INSERT INTO candidates(camera_id,captured_at,score,crop_path,frame_path,emb,bbox,status)"
                          " VALUES(?,?,?,?,?,?,?,?)", (cam_id, now, s, cp, fpth,
                          json.dumps([round(float(x), 4) for x in e]), json.dumps(list(bbox)), status))
        recent.insert(0, [cur.lastrowid, s, e, status, list(bbox)])
        if status == "new":
            found += 1
        else:
            near += 1
    return found, near


def retention(con):
    """Prune stale candidate rows AND their jpgs (files were previously orphaned forever)."""
    for status_, days in (("new", 7), ("near", NEAR_KEEP_DAYS)):
        cut = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - days * 86400))
        stale = con.execute("SELECT crop_path,frame_path FROM candidates WHERE captured_at < ? "
                            "AND status=?", (cut, status_)).fetchall()
        for row in stale:
            for f in row:
                if f and os.path.exists(f):
                    try:
                        os.remove(f)
                    except Exception:
                        pass
        con.execute("DELETE FROM candidates WHERE captured_at < ? AND status=?", (cut, status_))
    con.commit()


def sweep(con, focus=None, target=None):
    """One serial pass (one-shot modes: default, --wide/--pr, --collect). The 24/7 path is
    watch_loop(), which shares scan_clip/ingest but polls threaded and queues by tier."""
    embed = build_embedder()
    cen = load_centroid()
    det = detector()
    cams = dp.fetch_camera_list()
    dp.upsert_cameras(con, cams)
    foc = focus or FOCUS
    chosen = [c for c in cams if dp.props(c).get("available") == "true"
              and c["id"].replace("JamCams_", "") in foc]
    os.makedirs(CAND_DIR, exist_ok=True)
    tmp = os.path.join(CAND_DIR, "_tmp.mp4")
    found, fresh, near = 0, 0, 0
    for cam in chosen:
        short_id = cam["id"].replace("JamCams_", "")
        try:
            st, body, hdrs = dp.http_get(dp.props(cam).get("videoUrl"),
                                         etag=kv_get(con, f"etag:{short_id}"))
        except Exception:
            continue
        if st == 304 or not body:
            continue            # clip unchanged since last visit — zero download, zero decode
        fresh += 1
        open(tmp, "wb").write(body)
        try:
            best = scan_clip(det, tmp)
        except Exception:
            continue
        f, n = ingest(con, embed, cen, cam["id"], best)
        found += f
        near += n
        et = (hdrs.get("ETag") or "").strip() if hdrs else ""
        if et:
            kv_set(con, f"etag:{short_id}", et)
        con.commit()        # per-camera commit: keep WAL write transactions short
        if target and found >= target:
            break
    retention(con)
    print(f"cams checked: {len(chosen)} | fresh clips: {fresh} | vehicles: +{found} new, +{near} near",
          flush=True)


def _build_sheet(rows, out_path, cols=6, cap=72):
    """rows = [(id, score, crop_path), ...]; render up to `cap` into a grid. Returns count shown."""
    cells = []
    for cid, sc, cp in rows[:cap]:
        im = cv2.imread(cp)
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


def review_sheet(con, n=72):
    rows = con.execute("SELECT id,score,crop_path FROM candidates WHERE status='new' "
                       "ORDER BY score DESC LIMIT ?", (n,)).fetchall()
    out = os.path.join(BASE, "data/candidates/review_sheet.jpg")
    shown = _build_sheet(rows, out)
    print(f"review sheet ({shown} candidates) -> {out}  | confirm: live_capture.py --confirm <ids>"
          if shown else "no new candidates to review")


def confirm(con, ids, status):
    os.makedirs(REAL_DIR, exist_ok=True)
    for cid in ids:
        row = con.execute("SELECT crop_path,frame_path FROM candidates WHERE id=?", (cid,)).fetchone()
        if not row:
            continue
        if status == "waymo":
            for p in row:
                if p and os.path.exists(p):
                    import shutil
                    shutil.copy(p, os.path.join(REAL_DIR, os.path.basename(p)))
        con.execute("UPDATE candidates SET status=? WHERE id=?", (status, cid))
    con.commit()
    print(f"marked {len(ids)} candidates as {status}" + (f" -> copied to {REAL_DIR}" if status == "waymo" else ""))


def pending_count(con):
    """How many eligible candidates (status='new') are waiting to be sent."""
    return con.execute("SELECT COUNT(*) FROM candidates WHERE status='new' "
                       "AND COALESCE(sent,0)=0").fetchone()[0]


def day_budget(con):
    """Cells still sendable today under DAY_CAP (the user's review budget IS the constant;
    the effective score cut floats with volume)."""
    today = datetime.now(ZoneInfo("Europe/London")).strftime("%Y-%m-%d")
    used = int(kv_get(con, f"sent:{today}") or 0)
    return max(0, DAY_CAP - used), today, used


def send_digest(con, limit=None, reason="digest"):
    """Email the HIGHEST-SCORING unsent candidates (status='new', sent=0), best first, capped by
    `limit` and the day's remaining DAY_CAP budget (v0.5.1: score-ranked budgeted sending — the
    weak scorer means a fixed threshold either floods the user or silently bins Waymos; ranking
    against a fixed human budget maximises P(a real Waymo reaches human eyes) per review-minute).
    Rows are flagged sent=1 ONLY on a successful send, so a transient email failure just retries.
    Returns the number sent."""
    budget, today, used = day_budget(con)
    n = min(int(limit), budget) if limit else budget
    if n <= 0:
        return 0
    rows = con.execute("SELECT id,score,crop_path FROM candidates WHERE status='new' AND "
                       "COALESCE(sent,0)=0 ORDER BY score DESC LIMIT ?", (n,)).fetchall()
    if not rows:
        return 0
    sheet = os.path.join(BASE, "data/candidates/digest_sheet.jpg")
    shown = _build_sheet(rows, sheet, cap=len(rows))
    remaining = pending_count(con) - len(rows)
    note = f" — {remaining} more pending (lower-scored)" if remaining > 0 else ""
    subj = f"WaymoWatch: {len(rows)} possible Waymo(s) — top-scored, Waymo zone"
    if reason == "page":
        subj += f" (page; {remaining} more today)"
    elif reason == "end-of-day":
        subj += " (end of day)"
    cov = coverage_line(con)
    html = (f"<p><b>WaymoWatch — Waymo zone (spine + ~480 cams)</b>: the {len(rows)} "
            f"<b>highest-scoring</b> candidate(s){note}, best first.</p>"
            f"<p>Reply with the <b>#</b> of any that is a real Waymo "
            f"(white Jaguar I-PACE with a dark roof dome).</p>"
            + (f"<p style='color:#888'>{cov}</p>" if cov else ""))
    sys.path.insert(0, HERE)
    from email_alert import send_email
    if not send_email(subj, html, attachments=[sheet] if shown else None):
        print(f"digest send failed — will retry next tick ({len(rows)} pending)")
        return 0
    con.execute("UPDATE candidates SET sent=1 WHERE id IN (%s)"
                % ",".join(str(int(r[0])) for r in rows))
    kv_set(con, f"sent:{today}", str(used + len(rows)))
    con.commit()
    print(f"digest emailed: {len(rows)} ({reason}); {max(0, remaining)} still pending; "
          f"day budget {used + len(rows)}/{DAY_CAP}")
    return len(rows)


def emit_pages(con):
    """Send a full PAGE_SIZE email each time that many candidates have piled up during the day,
    'right away' (on the cycle that crosses the threshold), best-scored first, while the day's
    budget lasts. Loops in case a backlog spans several pages."""
    total = 0
    while pending_count(con) >= PAGE_SIZE and day_budget(con)[0] > 0:
        n = send_digest(con, limit=PAGE_SIZE, reason="page")
        if n == 0:
            break
        total += n
    return total


def maybe_send_instant_alerts(con):
    """Immediate alert for a near-certain sighting: email the moment any candidate lands at
    score >= ALERT_TH, instead of waiting for the 23:00 daily digest. Runs every sweep; the
    `alerted` flag guarantees each vehicle is sent at most once, and is set ONLY on a successful
    send so a transient email failure simply retries on the next cron tick. Vehicles whose score
    rises across sweeps to cross ALERT_TH are still picked up (their flag is unset until sent)."""
    rows = con.execute("SELECT id,score,crop_path,camera_id FROM candidates "
                       "WHERE status='new' AND score >= ? AND COALESCE(alerted,0)=0 "
                       "ORDER BY score DESC", (ALERT_TH,)).fetchall()
    if not rows:
        return 0
    sheet = os.path.join(BASE, "data/candidates/alert_sheet.jpg")
    shown = _build_sheet([(r[0], r[1], r[2]) for r in rows], sheet, cap=24)
    top_score, top_cam = rows[0][1], rows[0][3].replace("JamCams_", "")
    html = (f"<p><b>WaymoWatch — high-confidence sighting</b></p>"
            f"<p>{len(rows)} candidate(s) at score &ge; {ALERT_TH:.2f} just now "
            f"(top <b>{top_score:.2f}</b> at camera {top_cam}).</p>"
            f"<p>Reply with the <b>#</b> of any real Waymo (white Jaguar I-PACE, dark roof dome).</p>")
    sys.path.insert(0, HERE)
    from email_alert import send_email
    if send_email(f"\U0001F6A8 WaymoWatch: possible Waymo now — score {top_score:.2f} (cam {top_cam})",
                  html, attachments=[sheet] if shown else None):
        con.execute("UPDATE candidates SET alerted=1 WHERE id IN (%s)"
                    % ",".join(str(int(r[0])) for r in rows))
        con.commit()
        print(f"instant alert emailed: {len(rows)} candidate(s) >= {ALERT_TH}")
        return len(rows)
    print(f"instant alert send failed — will retry next tick ({len(rows)} pending)")
    return 0


def maybe_send_daily_digest(con):
    """End-of-day flush: at/after DIGEST_HOUR (London, after collection closes) flush any remaining
    full pages, then send the day's remainder (whatever is left, < PAGE_SIZE). Runs once per day.
    During the day emit_pages() has already sent the full 200s; this just mops up the tail. The
    collection window ends at 23:00 so no new candidates arrive after this — safe to mark the day done."""
    now = datetime.now(ZoneInfo("Europe/London"))
    if now.hour < DIGEST_HOUR:
        return
    today = now.strftime("%Y-%m-%d")
    row = con.execute("SELECT value FROM kv WHERE key='last_digest_date'").fetchone()
    if row and row[0] == today:
        return
    emit_pages(con)                          # drain any full pages first
    send_digest(con, reason="end-of-day")    # then the remainder, up to the day's budget
    # Overflow the budget couldn't cover is DEMOTED to the near archive (kept NEAR_KEEP_DAYS,
    # minable, retrievable if bars are re-cut) so each day's ranking starts fresh — except
    # anything at instant-alert level, which must stay eligible until actually sent.
    over = con.execute("UPDATE candidates SET status='near' WHERE status='new' AND "
                       "COALESCE(sent,0)=0 AND score < ?", (ALERT_TH,)).rowcount
    if over:
        print(f"end of day: {over} unsent candidates below the budget cut -> near archive")
    con.execute("INSERT OR REPLACE INTO kv(key,value) VALUES('last_digest_date',?)", (today,))
    con.commit()


def watch_loop(con):
    """Continuous ZONE watcher (v0.5, the cron entrypoint): every POLL_EVERY seconds one
    threaded conditional-GET pass over ALL watch cams — tier-1 spine + tier-2 Waymo zone,
    ~480 cams. POLL_EVERY < TfL's minimum refresh, so no published clip is ever skipped at
    the polling layer. Fresh clips queue per tier: spine processes first and is never
    dropped; the zone queue drops OLDEST on backlog (counted, never silent). Single process,
    single DB writer. Telemetry per poll-cycle -> `cycles` table + timestamped log line;
    a heartbeat file lets run_watch.sh kill a hung loop (cron restarts within 6 min)."""
    det, embed, cen = detector(), build_embedder(), load_centroid()
    os.makedirs(CAND_DIR, exist_ok=True)
    hb = os.path.join(CAND_DIR, "heartbeat")
    tmp = os.path.join(CAND_DIR, "_tmp.mp4")
    tier1, tier2, cam_index, t_cams = set(), set(), {}, 0.0
    q1, q2 = [], []                       # (t_fetch, short_id, clip_bytes) — FIFO per tier
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    polled = fresh1 = fresh2 = proc1 = proc2 = dropped = newc = nearc = 0
    cyc_t0, last_poll = time.time(), 0.0
    print(f"[{ts()}] watch loop v0.5: spine + zone, poll every {POLL_EVERY}s, 24/7", flush=True)
    while True:
        open(hb, "w").write(str(time.time()))
        now = time.time()
        if now - t_cams > 3600 or not cam_index:       # hourly watchlist refresh
            try:
                cams = dp.fetch_camera_list()
                dp.upsert_cameras(con, cams)
                con.commit()
                tier1, tier2, cam_index = zone_watchlist(cams)
                t_cams = now
                print(f"[{ts()}] watchlist: {len(tier1)} spine + {len(tier2)} zone cams", flush=True)
            except Exception as e:
                print(f"[{ts()}] camera list refresh failed: {e}", flush=True)
                time.sleep(30)
                continue
        if not in_collection_window():
            try:
                maybe_send_instant_alerts(con)
                maybe_send_daily_digest(con)
            except Exception as e:
                print(f"[{ts()}] send error: {e}", flush=True)
            time.sleep(60)
            continue
        if now - last_poll >= POLL_EVERY:
            if last_poll:                              # close + report the finished cycle
                try:
                    con.execute("INSERT INTO cycles(started_at,secs,polled,fresh,processed,dropped,"
                                "spine_fresh,spine_processed,new_cands,near_cands) "
                                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                                (started, round(now - cyc_t0, 1), polled, fresh1 + fresh2,
                                 proc1 + proc2, dropped, fresh1, proc1, newc, nearc))
                    con.commit()
                    print(f"[{ts()}] cycle: {polled} polled | +{fresh1 + fresh2} fresh (spine {fresh1})"
                          f" | processed {proc1 + proc2} | backlog {len(q1) + len(q2)}"
                          f" | dropped {dropped} | +{newc} new +{nearc} near"
                          f" | {now - cyc_t0:.0f}s", flush=True)
                    retention(con)
                    review_sheet(con)
                    emit_pages(con)        # page out a full digest the moment PAGE_SIZE pile up
                    maybe_send_instant_alerts(con)
                    maybe_send_daily_digest(con)
                except Exception as e:
                    print(f"[{ts()}] cycle-close error: {e}", flush=True)
                started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                polled = fresh1 = fresh2 = proc1 = proc2 = dropped = newc = nearc = 0
                cyc_t0 = time.time()
            try:
                res = poll_cams(con, cam_index, sorted(tier1) + sorted(tier2))
                polled = len(res)
                t_poll = time.time()
                for sid, body, et in res:
                    if body is None:
                        continue
                    if et:
                        kv_set(con, f"etag:{sid}", et)
                    note_refresh(con, sid, t_poll)
                    if sid in tier1:
                        q1.append((t_poll, sid, body))
                        fresh1 += 1
                    else:
                        q2.append((t_poll, sid, body))
                        fresh2 += 1
                con.commit()
                while len(q2) > MAX_BACKLOG:           # overload: shed OLDEST zone clips
                    q2.pop(0)
                    dropped += 1
            except Exception as e:
                print(f"[{ts()}] poll error: {e}", flush=True)
            last_poll = time.time()
        if q1 or q2:
            src = q1 if q1 else q2
            _, sid, body = src.pop(0)
            try:
                open(tmp, "wb").write(body)
                f, n = ingest(con, embed, cen, "JamCams_" + sid, scan_clip(det, tmp))
                con.commit()
                newc += f
                nearc += n
            except Exception as e:
                print(f"[{ts()}] clip error {sid}: {e}", flush=True)
            if src is q1:
                proc1 += 1
            else:
                proc2 += 1
        else:
            time.sleep(min(2.0, max(0.1, POLL_EVERY - (time.time() - last_poll))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cameras", type=int, default=0, help="0 = all zone cameras")
    ap.add_argument("--loop", action="store_true",
                    help="run forever: ETag-driven spine watch (cron supervises via flock)")
    ap.add_argument("--sample-every", type=int, default=SAMPLE_EVERY)
    ap.add_argument("--review", action="store_true")
    ap.add_argument("--digest", action="store_true", help="WhatsApp the operator a daily review nudge")
    ap.add_argument("--email-digest", action="store_true", help="email the operator a candidate digest + sheet")
    ap.add_argument("--collect", type=int, default=0, help="wipe + collect N distinct white cars (KX area) + email")
    ap.add_argument("--cams", type=int, default=70, help="nearest-KX cameras to use for --collect")
    ap.add_argument("--wide", type=int, default=0, help="live watch over the N nearest-KX cameras (else 8 core)")
    ap.add_argument("--pr", type=int, default=0, help="ALSO watch the N nearest cameras to Park Royal depot")
    ap.add_argument("--confirm", default="")
    ap.add_argument("--reject", default="")
    a = ap.parse_args()
    con = dp.db_connect(dp.DEFAULT_DB)
    ensure_schema(con)
    if a.loop:
        watch_loop(con)
    elif a.confirm:
        confirm(con, [int(x) for x in a.confirm.split(",") if x], "waymo")
    elif a.reject:
        confirm(con, [int(x) for x in a.reject.split(",") if x], "reject")
    elif a.review:
        review_sheet(con)
    elif a.digest:
        today = time.strftime("%Y-%m-%d", time.gmtime())
        n = con.execute("SELECT COUNT(*) FROM candidates WHERE captured_at LIKE ? AND status='new'",
                        (today + "%",)).fetchone()[0]
        top = con.execute("SELECT camera_id,score FROM candidates WHERE captured_at LIKE ? AND "
                          "status='new' ORDER BY score DESC LIMIT 1", (today + "%",)).fetchone()
        msg = f"WaymoWatch (King's Cross): {n} candidate(s) to review today."
        if top:
            msg += f" Top {top[1]:.2f} at {top[0].replace('JamCams_', '')}."
        sys.path.insert(0, HERE)
        from whatsapp_alert import send_to_user
        send_to_user(msg)
        print("digest:", msg)
    elif a.email_digest:
        sent = emit_pages(con) + send_digest(con, reason="manual")   # full pages + remainder, now
        print("email-digest: nothing new to send" if sent == 0 else f"email-digest: sent {sent}")
    elif a.collect:
        # wipe the candidate queue, then collect N distinct white cars from the KX area + email all
        con.execute("DELETE FROM candidates")
        con.commit()
        for f in glob.glob(os.path.join(CAND_DIR, "*.jpg")):
            try:
                os.remove(f)
            except Exception:
                pass
        cams = dp.fetch_camera_list()
        sweep(con, focus=nearest_short_ids(cams, a.cams), target=a.collect)
        rows = con.execute("SELECT id,score,crop_path FROM candidates WHERE status='new' "
                           "ORDER BY score DESC").fetchall()
        sheet = os.path.join(BASE, "data/candidates/collect_sheet.jpg")
        shown = _build_sheet(rows, sheet, cap=a.collect + 30)
        con.execute("UPDATE candidates SET sent=1")   # collected set goes out in THIS email
        con.commit()
        sys.path.insert(0, HERE)
        from email_alert import send_email
        send_email(f"WaymoWatch: {len(rows)} white cars (King's Cross area) to review",
                   f"<p><b>{len(rows)} distinct white cars</b> collected from the King's Cross area. "
                   f"Scan the attached sheet for a white Jaguar I-PACE with a dark roof dome and reply "
                   f"with the <b>#</b> of any Waymo.</p>",
                   attachments=[sheet] if shown else None)
        print(f"collected {len(rows)} white cars -> emailed ({shown} on sheet)")
    else:
        if in_collection_window():
            foc = None
            if a.wide or a.pr:                   # one sweep over the union of the active areas
                cams = dp.fetch_camera_list()
                foc = set()
                if a.wide:
                    foc |= nearest_short_ids(cams, a.wide, KX_CENTRE)
                if a.pr:
                    foc |= nearest_short_ids(cams, a.pr, PARK_ROYAL)
            sweep(con, focus=foc)                 # foc=None -> core 8 KX cams (FOCUS default)
            review_sheet(con)
            emit_pages(con)             # send a full email each time PAGE_SIZE pile up, right away
        else:
            now = datetime.now(ZoneInfo("Europe/London")).strftime("%H:%M %Z")
            print(f"outside collection window {COLLECT_HOURS[0]:02d}:00-{COLLECT_HOURS[1]:02d}:00 "
                  f"London (now {now}) — no sweep")
        maybe_send_instant_alerts(con)  # fire NOW on any score >= ALERT_TH; retries if a send failed
        maybe_send_daily_digest(con)    # end-of-day flush of the remainder (< PAGE_SIZE)


if __name__ == "__main__":
    main()
