#!/usr/bin/env python3
"""WaymoWatch data plane.

Pulls the TfL JamCam camera list, conditional-GETs each camera's latest ~11s video
clip from S3 (skipping clips we've already seen via ETag), extracts frames at a
chosen sample rate with OpenCV, and records everything in SQLite.

This is the no-regrets foundation: it produces the frames WaymoNet trains on and,
later, runs inference over. No detection happens here yet.

Powered by TfL Open Data.
"""
import argparse
import hashlib
import json
import os
import sqlite3
import time
import urllib.error
import urllib.request

import cv2

JAMCAM_LIST_URL = "https://api.tfl.gov.uk/Place/Type/JamCam"
CENTRAL_LONDON = (51.5074, -0.1278)  # Trafalgar Square
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.path.join(BASE, "data", "waymo.db")
DEFAULT_CLIPS = os.path.join(BASE, "data", "clips")
DEFAULT_FRAMES = os.path.join(BASE, "data", "frames")
UA = "Mozilla/5.0 (compatible; WaymoWatch/0.1; Powered by TfL Open Data)"

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS cameras (
    id TEXT PRIMARY KEY, short_id TEXT, common_name TEXT, view TEXT,
    lat REAL, lon REAL, available INTEGER, image_url TEXT, video_url TEXT,
    last_seen TEXT
);
CREATE TABLE IF NOT EXISTS clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id TEXT REFERENCES cameras(id),
    etag TEXT, last_modified TEXT, sha256 TEXT, bytes INTEGER,
    fps REAL, n_frames INTEGER, width INTEGER, height INTEGER, duration REAL,
    fetched_at TEXT, path TEXT,
    UNIQUE(camera_id, etag)
);
CREATE TABLE IF NOT EXISTS frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id INTEGER REFERENCES clips(id),
    camera_id TEXT, frame_idx INTEGER, t_sec REAL, path TEXT
);
-- analytics-grade tables, populated later by the detector + human review
CREATE TABLE IF NOT EXISTS sightings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id INTEGER, frame_id INTEGER, camera_id TEXT, lat REAL, lon REAL,
    captured_at TEXT, confidence REAL, crop_path TEXT,
    status TEXT DEFAULT 'unconfirmed',  -- unconfirmed|waymo|wayve|reject
    verifier TEXT, confirmed_at TEXT, dwell_group INTEGER, trajectory_id INTEGER
);
CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frame_id INTEGER, crop_path TEXT, label TEXT, source TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_frames_camera ON frames(camera_id);
CREATE INDEX IF NOT EXISTS idx_clips_camera ON clips(camera_id);
CREATE INDEX IF NOT EXISTS idx_sightings_status ON sightings(status);
"""


def db_connect(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    # 60 s: the loop must outwait any sibling writer (digest banking, audit) rather than error —
    # 10 s lost cycle-close/camera-refresh writes 5,916 times before 2026-07-02.
    con.execute("PRAGMA busy_timeout=60000")
    con.executescript(SCHEMA)
    return con


def http_get(url, etag=None, retries=3):
    """Return (status, body, headers). status 304 => not modified (body None).

    Retries transient connection failures with backoff (the feed occasionally
    drops connections under load / behind the CDN).
    """
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if etag:
        req.add_header("If-None-Match", etag)
    last_err = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                return resp.status, resp.read(), resp.headers
        except urllib.error.HTTPError as e:
            if e.code == 304:
                return 304, None, e.headers
            raise
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise last_err


def fetch_camera_list():
    _, body, _ = http_get(JAMCAM_LIST_URL)
    return json.loads(body)


def props(cam):
    return {p["key"]: p.get("value") for p in cam.get("additionalProperties", [])}


def upsert_cameras(con, cams):
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    rows = []
    for c in cams:
        p = props(c)
        img = p.get("imageUrl", "")
        short = c["id"].replace("JamCams_", "")
        rows.append((c["id"], short, c.get("commonName"), p.get("view"),
                     c.get("lat"), c.get("lon"),
                     1 if p.get("available") == "true" else 0,
                     img, p.get("videoUrl"), now))
    con.executemany(
        """INSERT INTO cameras(id,short_id,common_name,view,lat,lon,available,image_url,video_url,last_seen)
           VALUES(?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET available=excluded.available,
             image_url=excluded.image_url, video_url=excluded.video_url, last_seen=excluded.last_seen""",
        rows)
    con.commit()
    return len(rows)


def select_cameras(cams, n, area):
    avail = [c for c in cams if props(c).get("available") == "true" and props(c).get("videoUrl")]
    if area == "central":
        ay, ax = CENTRAL_LONDON
        avail.sort(key=lambda c: (c["lat"] - ay) ** 2 + (c["lon"] - ax) ** 2)
    return avail if n in (0, None) else avail[:n]


def fetch_clip(con, cam, clips_dir):
    """Conditional-GET a camera's clip. Returns clip row id, or None if unchanged."""
    cid = cam["id"]
    vid = props(cam).get("videoUrl")
    last = con.execute(
        "SELECT etag FROM clips WHERE camera_id=? ORDER BY id DESC LIMIT 1", (cid,)).fetchone()
    etag = last[0] if last else None
    status, body, headers = http_get(vid, etag=etag)
    if status == 304 or not body:
        return None, "unchanged"
    new_etag = headers.get("ETag")
    if new_etag and etag and new_etag == etag:
        return None, "same-etag"
    sha = hashlib.sha256(body).hexdigest()
    dup = con.execute("SELECT id FROM clips WHERE camera_id=? AND sha256=?", (cid, sha)).fetchone()
    if dup:
        return None, "same-bytes"
    short = cam["id"].replace("JamCams_", "")
    os.makedirs(clips_dir, exist_ok=True)
    path = os.path.join(clips_dir, f"{short}.{sha[:12]}.mp4")
    with open(path, "wb") as f:
        f.write(body)
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cur = con.execute(
        """INSERT OR IGNORE INTO clips(camera_id,etag,last_modified,sha256,bytes,fps,n_frames,width,height,duration,fetched_at,path)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
        (cid, new_etag, headers.get("Last-Modified"), sha, len(body), fps, n, w, h,
         (n / fps if fps else 0.0), now, path))
    con.commit()
    return cur.lastrowid, "new"


def extract_frames(con, clip_id, cam, sample_fps, frames_dir):
    row = con.execute("SELECT path, fps FROM clips WHERE id=?", (clip_id,)).fetchone()
    if not row:
        return 0
    path, fps = row
    fps = fps or 25.0
    step = max(1, round(fps / sample_fps))
    short = cam["id"].replace("JamCams_", "")
    out_dir = os.path.join(frames_dir, short, str(clip_id))
    os.makedirs(out_dir, exist_ok=True)
    cap = cv2.VideoCapture(path)
    idx = saved = 0
    rows = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            fp = os.path.join(out_dir, f"f{idx:04d}.jpg")
            cv2.imwrite(fp, frame)
            rows.append((clip_id, cam["id"], idx, idx / fps, fp))
            saved += 1
        idx += 1
    cap.release()
    con.executemany(
        "INSERT INTO frames(clip_id,camera_id,frame_idx,t_sec,path) VALUES(?,?,?,?,?)", rows)
    con.commit()
    return saved


def main():
    ap = argparse.ArgumentParser(description="WaymoWatch data plane (Powered by TfL Open Data)")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--clips-dir", default=DEFAULT_CLIPS)
    ap.add_argument("--frames-dir", default=DEFAULT_FRAMES)
    ap.add_argument("--cameras", type=int, default=12, help="how many cameras (0 = all available)")
    ap.add_argument("--area", choices=["central", "all"], default="central")
    ap.add_argument("--sample-fps", type=float, default=5.0, help="frames/sec to extract per clip")
    args = ap.parse_args()

    t0 = time.time()
    con = db_connect(args.db)
    cams = fetch_camera_list()
    upsert_cameras(con, cams)
    chosen = select_cameras(cams, args.cameras, args.area)
    print(f"cameras: {len(cams)} total, {sum(1 for c in cams if props(c).get('available')=='true')} available; "
          f"processing {len(chosen)} ({args.area})")

    stats = {"new": 0, "unchanged": 0, "same-bytes": 0, "same-etag": 0, "frames": 0, "errors": 0}
    for c in chosen:
        try:
            clip_id, why = fetch_clip(con, c, args.clips_dir)
            stats[why] = stats.get(why, 0) + 1
            if clip_id:
                got = extract_frames(con, clip_id, c, args.sample_fps, args.frames_dir)
                stats["frames"] += got
                print(f"  {c['id']:<22} {c.get('commonName','')[:28]:<28} clip#{clip_id} +{got} frames")
            else:
                print(f"  {c['id']:<22} {c.get('commonName','')[:28]:<28} ({why})")
        except Exception as e:  # keep the sweep going
            stats["errors"] += 1
            print(f"  {c['id']:<22} ERROR {type(e).__name__}: {e}")

    con.execute("INSERT OR REPLACE INTO kv(key,value) VALUES('last_sweep',?)",
                (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),))
    con.commit()
    print(f"\nsweep done in {time.time()-t0:.1f}s | "
          + " ".join(f"{k}={v}" for k, v in stats.items()))
    tot = con.execute("SELECT (SELECT COUNT(*) FROM clips),(SELECT COUNT(*) FROM frames)").fetchone()
    print(f"db totals: clips={tot[0]} frames={tot[1]} -> {args.db}")


if __name__ == "__main__":
    main()
