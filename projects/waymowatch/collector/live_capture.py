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

# central + inner London bounding box (~Waymo's 20 test boroughs)
ZONE = dict(lat0=51.44, lat1=51.57, lon0=-0.27, lon1=0.04)
CAND_DIR = os.path.join(BASE, "data", "candidates")
REAL_DIR = os.path.join(BASE, "data", "real_positives")
SAMPLE_EVERY = 8       # ~3 fps — enough chances to catch a pass, light on CPU
MIN_H = 44             # host vehicle must be near/mid field (dome resolvable)
SCORE_THRESH = 0.80    # cosine to dome centroid — wide net; humans filter


def ensure_schema(con):
    con.executescript("""
    CREATE TABLE IF NOT EXISTS candidates(
      id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT, captured_at TEXT,
      score REAL, crop_path TEXT, frame_path TEXT, status TEXT DEFAULT 'new');
    CREATE INDEX IF NOT EXISTS idx_cand_status ON candidates(status);""")


def dome_centroid(embed):
    domes = glob.glob(os.path.join(BASE, "data/sources/domes/*.jpg"))
    c = np.mean([embed(jamcam(cv2.imread(f))) for f in domes], 0)
    return c / (np.linalg.norm(c) + 1e-8)


def in_zone(c):
    return (c.get("lat") and ZONE["lat0"] <= c["lat"] <= ZONE["lat1"]
            and ZONE["lon0"] <= c["lon"] <= ZONE["lon1"])


def sweep(con, n, sample_every):
    from ultralytics import YOLO
    embed = build_embedder()
    cen = dome_centroid(embed)
    det = YOLO("yolo11n.pt")
    cams = dp.fetch_camera_list()
    dp.upsert_cameras(con, cams)
    zone = [c for c in cams if dp.props(c).get("available") == "true" and in_zone(c)]
    chosen = zone[:n] if n else zone
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
                    mx = int((x2 - x1) * 0.16)
                    roof = fr[max(0, int(y1 - (y2 - y1) * 0.06)):int(y1 + (y2 - y1) * 0.45),
                              max(0, x1 + mx):min(fr.shape[1], x2 - mx)]
                    if roof.size == 0 or min(roof.shape[:2]) < 6:
                        continue
                    s = float(embed(jamcam(roof)) @ cen)
                    if s >= SCORE_THRESH:
                        cp = os.path.join(CAND_DIR, f"{short}_{idx}_{int(s*100)}.jpg")
                        fpth = os.path.join(CAND_DIR, f"{short}_{idx}_frame.jpg")
                        cv2.imwrite(cp, roof); cv2.imwrite(fpth, fr)
                        con.execute("INSERT INTO candidates(camera_id,captured_at,score,crop_path,frame_path)"
                                    " VALUES(?,?,?,?,?)", (cam["id"], now, s, cp, fpth))
                        found += 1
            idx += 1
        cap.release()
    con.commit()
    print(f"zone cameras available: {len(zone)} | swept: {len(chosen)} | new candidates >= {SCORE_THRESH}: {found}")


def review_sheet(con, n=24):
    rows = con.execute("SELECT id,camera_id,score,crop_path FROM candidates WHERE status='new' "
                       "ORDER BY score DESC LIMIT ?", (n,)).fetchall()
    if not rows:
        print("no new candidates to review"); return
    cells = []
    for cid, cam, sc, cp in rows:
        im = cv2.imread(cp)
        if im is None:
            continue
        c = cv2.resize(im, (200, 150), interpolation=cv2.INTER_NEAREST)
        cv2.rectangle(c, (0, 0), (96, 20), (0, 0, 0), -1)
        cv2.putText(c, f"#{cid} {sc:.2f}", (3, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (0, 255, 255), 1)
        cells.append(c)
    cols = 6
    cells += [np.full((150, 200, 3), 35, np.uint8)] * ((-len(cells)) % cols)
    grid = np.vstack([np.hstack(cells[i:i + cols]) for i in range(0, len(cells), cols)])
    out = os.path.join(BASE, "data/candidates/review_sheet.jpg")
    cv2.imwrite(out, grid)
    print(f"review sheet ({len(rows)} candidates) -> {out}  | confirm with: live_capture.py --confirm <ids>")


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
    else:
        sweep(con, a.cameras, a.sample_every)
        review_sheet(con)


if __name__ == "__main__":
    main()
