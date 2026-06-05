#!/usr/bin/env python3
"""WaymoWatch live capture loop — surface real Waymo candidates from the live JamCam feed.

The only perfectly on-distribution data source: real Waymos on real cameras at the real
elevated angle/scale. Bootstraps before a good detector exists with a no-GPU, no-API surfacer:
  poll TfL -> decode each clip -> sample frames -> generic car detector -> roof crop ->
  cosine similarity to our 39 real dome templates -> store anything roof-structure-ish as a
  CANDIDATE for human review. You confirm; confirmed crops become gold real positives.

Modes:
  (default)         one sweep over the Waymo-zone cameras, then rebuild the review sheet
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

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(BASE, "dataset"))
import data_plane as dp  # noqa: E402
from separability_eval import build_embedder, jamcam  # noqa: E402

# central + inner London bounding box (~Waymo's 20 test boroughs) — wide-net fallback
ZONE = dict(lat0=51.44, lat1=51.57, lon0=-0.27, lon1=0.04)
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
PROB_TH = 0.83        # high-probability bar: keep/email only candidates more dome-like than ~98%
                      # of 221 vetted white non-Waymos (their p98=0.83, max=0.87). Tunable.
BATCH_SIZE = 5        # email the operator each time this many new high-prob candidates accumulate
CAND_DIR = os.path.join(BASE, "data", "candidates")
REAL_DIR = os.path.join(BASE, "data", "real_positives")
SAMPLE_EVERY = 8       # ~3 fps — enough chances to catch a pass, light on CPU
MIN_H = 44             # host vehicle must be near/mid field (dome resolvable)
SCORE_THRESH = 0.80    # cosine to dome centroid — wide net; humans filter


def ensure_schema(con):
    con.executescript("""
    CREATE TABLE IF NOT EXISTS candidates(
      id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT, captured_at TEXT,
      score REAL, crop_path TEXT, frame_path TEXT, status TEXT DEFAULT 'new', emb TEXT, bbox TEXT);
    CREATE INDEX IF NOT EXISTS idx_cand_status ON candidates(status);
    CREATE INDEX IF NOT EXISTS idx_cand_cam ON candidates(camera_id);""")
    for col in ("emb TEXT", "bbox TEXT"):                  # for pre-existing tables
        try:
            con.execute(f"ALTER TABLE candidates ADD COLUMN {col}")
        except Exception:
            pass


def dome_centroid(embed):
    domes = glob.glob(os.path.join(BASE, "data/sources/domes/*.jpg"))
    c = np.mean([embed(jamcam(cv2.imread(f))) for f in domes], 0)
    return c / (np.linalg.norm(c) + 1e-8)


def in_zone(c):
    return (c.get("lat") and ZONE["lat0"] <= c["lat"] <= ZONE["lat1"]
            and ZONE["lon0"] <= c["lon"] <= ZONE["lon1"])


def nearest_short_ids(cams, k, centre=KX_CENTRE):
    avail = [c for c in cams if dp.props(c).get("available") == "true"
             and dp.props(c).get("videoUrl") and c.get("lat")]
    avail.sort(key=lambda c: (c["lat"] - centre[0]) ** 2 + (c["lon"] - centre[1]) ** 2)
    return {c["id"].replace("JamCams_", "") for c in avail[:k]}


def is_white(car):
    """Stage-1 cheap colour filter: Waymos are (predominantly) white. Lenient — also passes
    silver/off-white and white-in-shadow so we don't miss a Waymo; white vans/cabs pass too
    (they're the hard negatives Stage 2 needs). Discards red buses, black cabs, dark/coloured cars."""
    if car is None or car.size == 0:
        return False
    h, w = car.shape[:2]
    c = car[int(h * 0.20):int(h * 0.85), int(w * 0.20):int(w * 0.80)]  # central body, skip road/edges
    if c.size == 0:
        return False
    hsv = cv2.cvtColor(c, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2].astype(np.float32) / 255.0
    s = hsv[:, :, 1].astype(np.float32) / 255.0
    whiteish = ((v > 0.55) & (s < 0.28)).mean()   # bright + desaturated body panels
    return whiteish > 0.30


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def sweep(con, focus=None, target=None):
    from ultralytics import YOLO
    embed = build_embedder()
    cen = dome_centroid(embed)
    det = YOLO("yolo11n.pt")
    cams = dp.fetch_camera_list()
    dp.upsert_cameras(con, cams)
    foc = focus or FOCUS
    chosen = [c for c in cams if dp.props(c).get("available") == "true"
              and c["id"].replace("JamCams_", "") in foc]
    os.makedirs(CAND_DIR, exist_ok=True)
    tmp = os.path.join(CAND_DIR, "_tmp.mp4")
    found = 0
    for cam in chosen:
        try:
            _, body, _ = dp.http_get(dp.props(cam).get("videoUrl"))
        except Exception:
            continue
        if not body:
            continue
        open(tmp, "wb").write(body)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        short = cam["id"].replace("JamCams_", "")
        stamp = now.replace("-", "").replace(":", "").replace("T", "").replace("Z", "")
        # within-clip ByteTrack: collapse each moving car (many frames) into ONE track;
        # keep its biggest (closest) view as the representative.
        best = {}  # track id -> (bbox_area, frame, bbox)
        try:
            for r in det.track(tmp, persist=False, tracker="bytetrack.yaml", classes=[2],
                               conf=0.30, imgsz=352, vid_stride=3, stream=True, verbose=False):
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
        except Exception:
            continue
        # recent entries at this camera, for cross-sweep dedup (parked cars = same bbox spot)
        recent = [[rid, rsc, np.array(json.loads(remb)), st, (json.loads(bb) if bb else None)]
                  for rid, rsc, remb, st, bb in con.execute(
                      "SELECT id,score,emb,status,bbox FROM candidates WHERE camera_id=? "
                      "ORDER BY id DESC LIMIT 400", (cam["id"],)).fetchall() if remb]
        for tid, (area, frm, bbox) in best.items():
            x1, y1, x2, y2 = bbox
            mx = int((x2 - x1) * 0.16)
            roof = frm[max(0, int(y1 - (y2 - y1) * 0.06)):int(y1 + (y2 - y1) * 0.45),
                       max(0, x1 + mx):min(frm.shape[1], x2 - mx)]
            if roof.size == 0 or min(roof.shape[:2]) < 6:
                continue
            e = embed(jamcam(roof))
            s = float(e @ cen)
            if s < PROB_TH:
                continue  # only keep high-probability (dome-like) candidates; discard the rest
            hd = int((y2 - y1) * 0.12)
            car = frm[max(0, y1 - hd):y2, max(0, x1):min(frm.shape[1], x2)]
            # same vehicle if same parked spot (bbox IoU) OR near-identical appearance
            m = next((c for c in recent if (c[4] and iou(bbox, c[4]) > 0.45)
                      or float(e @ c[2]) >= DEDUP_TH), None)
            cp = os.path.join(CAND_DIR, f"{short}_t{tid}_{stamp}.jpg")
            fpth = os.path.join(CAND_DIR, f"{short}_t{tid}_{stamp}_frame.jpg")
            if m:
                if m[3] == "new" and s > m[1] + 0.01:        # better view -> update existing entry
                    old = con.execute("SELECT crop_path,frame_path FROM candidates WHERE id=?", (m[0],)).fetchone()
                    cv2.imwrite(cp, car); cv2.imwrite(fpth, frm)
                    con.execute("UPDATE candidates SET score=?,crop_path=?,frame_path=?,emb=?,bbox=?,captured_at=? "
                                "WHERE id=?", (s, cp, fpth, json.dumps([round(float(x), 4) for x in e]),
                                               json.dumps(list(bbox)), now, m[0]))
                    for f in (old or []):
                        if f and f not in (cp, fpth) and os.path.exists(f):
                            try:
                                os.remove(f)
                            except Exception:
                                pass
                    m[1], m[2], m[4] = s, e, list(bbox)
                continue                                      # same vehicle -> no new row
            cv2.imwrite(cp, car); cv2.imwrite(fpth, frm)
            cur = con.execute("INSERT INTO candidates(camera_id,captured_at,score,crop_path,frame_path,emb,bbox)"
                              " VALUES(?,?,?,?,?,?,?)", (cam["id"], now, s, cp, fpth,
                              json.dumps([round(float(x), 4) for x in e]), json.dumps(list(bbox))))
            recent.insert(0, [cur.lastrowid, s, e, "new", list(bbox)])
            found += 1
        if target and found >= target:
            break
    cut = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 7 * 86400))
    con.execute("DELETE FROM candidates WHERE captured_at < ? AND status='new'", (cut,))
    con.commit()
    print(f"focus cameras swept: {len(chosen)} | distinct vehicles added: {found}")


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


def send_digest(con, force=False):
    """Email the operator the new high-probability candidates since the last digest.
    Auto-fires once BATCH_SIZE have accumulated; force=True sends whatever is pending."""
    row = con.execute("SELECT value FROM kv WHERE key='last_digest_id'").fetchone()
    last_id = int(row[0]) if row else 0
    rows = con.execute("SELECT id,score,crop_path FROM candidates WHERE id>? AND status='new' "
                       "ORDER BY score DESC", (last_id,)).fetchall()
    if not rows or (not force and len(rows) < BATCH_SIZE):
        return 0
    sheet = os.path.join(BASE, "data/candidates/digest_sheet.jpg")
    shown = _build_sheet(rows, sheet, cap=max(72, BATCH_SIZE + 12))
    maxid = con.execute("SELECT MAX(id) FROM candidates").fetchone()[0] or last_id
    con.execute("INSERT OR REPLACE INTO kv(key,value) VALUES('last_digest_id',?)", (str(maxid),))
    con.commit()
    more = f" (+{len(rows) - shown} more)" if len(rows) > shown else ""
    html = (f"<p><b>WaymoWatch — King's Cross + Park Royal</b>: {len(rows)} <b>high-probability</b> "
            f"Waymo candidate(s){more}.</p><p>Reply with the <b>#</b> of any that is a real Waymo "
            f"(white Jaguar I-PACE with a dark roof dome).</p>")
    sys.path.insert(0, HERE)
    from email_alert import send_email
    send_email(f"WaymoWatch: {len(rows)} possible Waymo(s) — KX + Park Royal", html,
               attachments=[sheet] if shown else None)
    print(f"digest emailed: {len(rows)} high-prob candidate(s) (force={force})")
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cameras", type=int, default=0, help="0 = all zone cameras")
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
    if a.confirm:
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
        if send_digest(con, force=True) == 0:
            print("email-digest: nothing new to send")
    elif a.collect:
        # wipe the candidate queue, then collect N distinct white cars from the KX area + email all
        con.execute("DELETE FROM candidates")
        con.execute("DELETE FROM kv WHERE key='last_digest_id'")
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
        con.execute("INSERT OR REPLACE INTO kv(key,value) VALUES('last_digest_id',?)",
                    (str(con.execute("SELECT MAX(id) FROM candidates").fetchone()[0] or 0),))
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
        foc = None
        if a.wide or a.pr:                       # one sweep over the union of the active areas
            cams = dp.fetch_camera_list()
            foc = set()
            if a.wide:
                foc |= nearest_short_ids(cams, a.wide, KX_CENTRE)
            if a.pr:
                foc |= nearest_short_ids(cams, a.pr, PARK_ROYAL)
        sweep(con, focus=foc)                     # foc=None -> core 8 KX cams (FOCUS default)
        review_sheet(con)
        send_digest(con)   # auto-email once BATCH_SIZE new high-prob candidates have accumulated


if __name__ == "__main__":
    main()
