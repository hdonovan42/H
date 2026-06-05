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
TOPK_PER_CAM = 3      # keep only the most dome-like vehicles per camera per sweep
SCORE_FLOOR = 0.50
CAND_DIR = os.path.join(BASE, "data", "candidates")
REAL_DIR = os.path.join(BASE, "data", "real_positives")
SAMPLE_EVERY = 8       # ~3 fps — enough chances to catch a pass, light on CPU
MIN_H = 44             # host vehicle must be near/mid field (dome resolvable)
SCORE_THRESH = 0.80    # cosine to dome centroid — wide net; humans filter


def ensure_schema(con):
    con.executescript("""
    CREATE TABLE IF NOT EXISTS candidates(
      id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT, captured_at TEXT,
      score REAL, crop_path TEXT, frame_path TEXT, status TEXT DEFAULT 'new', emb TEXT);
    CREATE INDEX IF NOT EXISTS idx_cand_status ON candidates(status);
    CREATE INDEX IF NOT EXISTS idx_cand_cam ON candidates(camera_id);""")
    try:
        con.execute("ALTER TABLE candidates ADD COLUMN emb TEXT")  # for pre-existing tables
    except Exception:
        pass


def dome_centroid(embed):
    domes = glob.glob(os.path.join(BASE, "data/sources/domes/*.jpg"))
    c = np.mean([embed(jamcam(cv2.imread(f))) for f in domes], 0)
    return c / (np.linalg.norm(c) + 1e-8)


def in_zone(c):
    return (c.get("lat") and ZONE["lat0"] <= c["lat"] <= ZONE["lat1"]
            and ZONE["lon0"] <= c["lon"] <= ZONE["lon1"])


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


def sweep(con, n, sample_every):
    from ultralytics import YOLO
    embed = build_embedder()
    cen = dome_centroid(embed)
    det = YOLO("yolo11n.pt")
    cams = dp.fetch_camera_list()
    dp.upsert_cameras(con, cams)
    chosen = [c for c in cams if dp.props(c).get("available") == "true"
              and c["id"].replace("JamCams_", "") in FOCUS]
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
        cap = cv2.VideoCapture(tmp)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        short = cam["id"].replace("JamCams_", "")
        idx = 0
        cand = []
        while True:
            ok, fr = cap.read()
            if not ok:
                break
            if idx % sample_every == 0:
                r = det.predict(fr, conf=0.30, verbose=False, imgsz=352)[0]
                for b in r.boxes:
                    if int(b.cls[0]) != 2:
                        continue
                    x1, y1, x2, y2 = map(int, b.xyxy[0].tolist())
                    if (y2 - y1) < MIN_H:
                        continue
                    if not is_white(fr[max(0, y1):y2, max(0, x1):x2]):
                        continue  # Stage-1 colour filter — discard non-white traffic cheaply
                    mx = int((x2 - x1) * 0.16)
                    roof = fr[max(0, int(y1 - (y2 - y1) * 0.06)):int(y1 + (y2 - y1) * 0.45),
                              max(0, x1 + mx):min(fr.shape[1], x2 - mx)]
                    if roof.size == 0 or min(roof.shape[:2]) < 6:
                        continue
                    e = embed(jamcam(roof))           # roof band -> dome-similarity ranking
                    hd = int((y2 - y1) * 0.12)
                    car = fr[max(0, y1 - hd):min(fr.shape[0], y2), max(0, x1):min(fr.shape[1], x2)]
                    cand.append((float(e @ cen), car.copy(), fr.copy(), idx, e))  # save WHOLE car
            idx += 1
        cap.release()
        # keep only the most dome-like vehicles at this camera this sweep (bounds review volume),
        # and skip ones near-identical to recent candidates at this camera (parked-vehicle dedup)
        recent = [np.array(json.loads(r[0])) for r in con.execute(
            "SELECT emb FROM candidates WHERE camera_id=? AND emb IS NOT NULL ORDER BY id DESC LIMIT 80",
            (cam["id"],)).fetchall() if r[0]]
        for s, crop, frm, fi, e in sorted(cand, key=lambda t: -t[0])[:TOPK_PER_CAM]:
            if s < SCORE_FLOOR:
                break
            if recent and max(float(e @ r) for r in recent) > 0.96:
                continue  # same (likely parked) vehicle already queued for this camera
            cp = os.path.join(CAND_DIR, f"{short}_{fi}_{int(s*100)}.jpg")
            fpth = os.path.join(CAND_DIR, f"{short}_{fi}_frame.jpg")
            cv2.imwrite(cp, crop); cv2.imwrite(fpth, frm)
            con.execute("INSERT INTO candidates(camera_id,captured_at,score,crop_path,frame_path,emb)"
                        " VALUES(?,?,?,?,?,?)", (cam["id"], now, s, cp, fpth,
                        json.dumps([round(float(x), 4) for x in e])))
            recent.append(e); found += 1
    cut = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 7 * 86400))
    con.execute("DELETE FROM candidates WHERE captured_at < ? AND status='new'", (cut,))
    con.commit()
    print(f"focus cameras swept: {len(chosen)} | new candidates (top-{TOPK_PER_CAM}/cam ≥ {SCORE_FLOOR}): {found}")


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cameras", type=int, default=0, help="0 = all zone cameras")
    ap.add_argument("--sample-every", type=int, default=SAMPLE_EVERY)
    ap.add_argument("--review", action="store_true")
    ap.add_argument("--digest", action="store_true", help="WhatsApp the operator a daily review nudge")
    ap.add_argument("--email-digest", action="store_true", help="email the operator a candidate digest + sheet")
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
        row = con.execute("SELECT value FROM kv WHERE key='last_digest_id'").fetchone()
        last_id = int(row[0]) if row else 0
        rows = con.execute("SELECT id,score,crop_path FROM candidates WHERE id>? AND status='new' "
                           "ORDER BY score DESC", (last_id,)).fetchall()
        total = len(rows)
        if total == 0:
            print("email-digest: no new candidates since last digest — skipping")
        else:
            sheet = os.path.join(BASE, "data/candidates/digest_sheet.jpg")
            shown = _build_sheet(rows, sheet)
            maxid = con.execute("SELECT MAX(id) FROM candidates").fetchone()[0] or last_id
            con.execute("INSERT OR REPLACE INTO kv(key,value) VALUES('last_digest_id',?)", (str(maxid),))
            con.commit()
            more = f" (+{total - shown} more — review on the capture box)" if total > shown else ""
            html = (f"<p><b>WaymoWatch — King's Cross</b>: {total} new candidate(s) since the last digest"
                    f" — showing {shown}{more}.</p><p>Scan the attached sheet for a white I-PACE with a "
                    f"dark roof dome; reply with its <b>#</b> to confirm a real one.</p>")
            sys.path.insert(0, HERE)
            from email_alert import send_email
            send_email(f"WaymoWatch: {total} new King's Cross candidate(s)", html,
                       attachments=[sheet] if os.path.exists(sheet) else None)
            print(f"email-digest: {total} new ({shown} shown) -> advanced last_digest_id to {maxid}")
    else:
        sweep(con, a.cameras, a.sample_every)
        review_sheet(con)


if __name__ == "__main__":
    main()
