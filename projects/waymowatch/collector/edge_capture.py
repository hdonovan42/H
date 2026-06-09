#!/usr/bin/env python3
"""WaymoWatch EDGE capture — continuous surfacer for a self-hosted camera at a chokepoint.

Unlike the JamCam sweep (rolling ~10s clips => ~2.7% temporal coverage of each spot), this consumes
a LIVE stream end-to-end, so it sees ~100% of the footage at one high-value location — e.g. the
Park Royal depot egress or the A40, where every Waymo is guaranteed to pass.

Source is anything OpenCV/Ultralytics can open:
  --source rtsp://user:pass@192.168.1.50:554/Streaming/Channels/101   # IP / CCTV camera
  --source http://192.168.1.51:8080/video                             # Android 'IP Webcam' app
  --source 0                                                          # USB webcam
  --source /path/to/test.mp4                                          # offline test

It reuses the JamCam pipeline's scoring (Stage-1 is_white + dome-similarity surfacer), the shared
candidates DB, and the alert machinery — so edge sightings flow into the SAME daily digest / instant
alerts as JamCam candidates (camera_id is tagged EDGE_<name>). Each vehicle is tracked (ByteTrack
persist=True) and emitted ONCE, at its biggest/closest view, if it ever clears PROB_TH.

Run as a long-lived process (systemd, Restart=always) on a Pi / mini-PC at the camera, or on any
box the stream reaches. See EDGE_CAMERA.md for hardware + deployment.
"""
import argparse
import json
import os
import sys
import time

import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(BASE, "dataset"))
import data_plane as dp  # noqa: E402
from separability_eval import build_embedder, jamcam  # noqa: E402
import live_capture as lc  # noqa: E402  (reuse dome_centroid, is_white, ensure_schema, thresholds, alerts)


def roof_score(frm, bbox, embed, cen):
    """Embed the roof region of a detected car and return (embedding, cosine-to-dome-centroid).
    Mirrors the JamCam pipeline exactly (incl. the jamcam() degrade) so scores are comparable."""
    x1, y1, x2, y2 = bbox
    mx = int((x2 - x1) * 0.16)
    roof = frm[max(0, int(y1 - (y2 - y1) * 0.06)):int(y1 + (y2 - y1) * 0.45),
               max(0, x1 + mx):min(frm.shape[1], x2 - mx)]
    if roof.size == 0 or min(roof.shape[:2]) < 6:
        return None
    e = embed(jamcam(roof))
    return e, float(e @ cen)


def emit(con, cam_id, name, t):
    """Persist one vehicle as a candidate (same schema/flow as the JamCam sweep)."""
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    stamp = now.replace("-", "").replace(":", "").replace("T", "").replace("Z", "")
    x1, y1, x2, y2 = t["bbox"]
    frm = t["frame"]
    hd = int((y2 - y1) * 0.12)
    car = frm[max(0, y1 - hd):y2, max(0, x1):min(frm.shape[1], x2)]
    os.makedirs(lc.CAND_DIR, exist_ok=True)
    cp = os.path.join(lc.CAND_DIR, f"{name}_{stamp}_t{t['tid']}.jpg")
    fpth = os.path.join(lc.CAND_DIR, f"{name}_{stamp}_t{t['tid']}_frame.jpg")
    cv2.imwrite(cp, car)
    cv2.imwrite(fpth, frm)
    con.execute("INSERT INTO candidates(camera_id,captured_at,score,crop_path,frame_path,emb,bbox)"
                " VALUES(?,?,?,?,?,?,?)",
                (cam_id, now, t["score"], cp, fpth,
                 json.dumps([round(float(x), 4) for x in t["emb"]]), json.dumps(list(t["bbox"]))))
    con.commit()
    print(f"EDGE candidate: {cam_id} score={t['score']:.3f} -> {cp}", flush=True)


def run_once(det, embed, cen, con, cam_id, a):
    """One streaming session over the source. Returns when the stream ends (file done / disconnect)."""
    src = int(a.source) if a.source.isdigit() else a.source
    tracks = {}      # tid -> {area, score, frame, bbox, emb, last, tid}
    emitted = set()
    fi = 0
    for r in det.track(src, stream=True, persist=True, classes=[2], conf=a.conf,
                       imgsz=a.imgsz, vid_stride=a.stride, verbose=False):
        fi += 1
        frm = r.orig_img
        present = set()
        if r.boxes is not None and r.boxes.id is not None:
            for b in r.boxes:
                x1, y1, x2, y2 = map(int, b.xyxy[0].tolist())
                if (y2 - y1) < a.min_h:
                    continue
                if not lc.is_white(frm[max(0, y1):y2, max(0, x1):x2]):
                    continue
                tid = int(b.id[0])
                present.add(tid)
                area = (x2 - x1) * (y2 - y1)
                t = tracks.get(tid)
                if t is None or area > t["area"]:           # keep the biggest (closest) view
                    sc = roof_score(frm, (x1, y1, x2, y2), embed, cen)
                    if sc is None:
                        continue
                    e, s = sc
                    tracks[tid] = dict(area=area, score=s, frame=frm.copy(),
                                       bbox=(x1, y1, x2, y2), emb=e, last=fi, tid=tid)
                else:
                    t["last"] = fi
        # finalize vehicles that have left the frame
        for tid in [k for k, v in tracks.items() if k not in present and fi - v["last"] > a.gone_frames]:
            t = tracks.pop(tid)
            if t["score"] >= lc.PROB_TH and tid not in emitted:
                emit(con, cam_id, a.name, t)
                emitted.add(tid)
        if fi % a.alert_every == 0 and not a.no_email:
            lc.maybe_send_instant_alerts(con)   # fast ≥ALERT_TH alert, dedup via `alerted` flag
    # stream ended: flush any still-tracked vehicles
    for tid, t in tracks.items():
        if t["score"] >= lc.PROB_TH and tid not in emitted:
            emit(con, cam_id, a.name, t)
    if not a.no_email:
        lc.maybe_send_instant_alerts(con)
    return fi


def main():
    ap = argparse.ArgumentParser(description="WaymoWatch edge (chokepoint) camera capture")
    ap.add_argument("--source", required=True, help="rtsp://… | http://…/video | 0 (webcam) | file.mp4")
    ap.add_argument("--name", default="depot", help="camera label -> camera_id EDGE_<name>")
    ap.add_argument("--db", default=dp.DEFAULT_DB, help="SQLite db (default: shared waymo.db)")
    ap.add_argument("--conf", type=float, default=0.30, help="YOLO car-detection confidence")
    ap.add_argument("--imgsz", type=int, default=640, help="inference size (640 for a real hi-res cam)")
    ap.add_argument("--stride", type=int, default=6, help="process every Nth frame (~4fps @ 25fps source)")
    ap.add_argument("--min-h", type=int, default=lc.MIN_H, help="min vehicle px height (raise for a close cam)")
    ap.add_argument("--gone-frames", type=int, default=8, help="finalise a track after it's unseen this long")
    ap.add_argument("--alert-every", type=int, default=120, help="check instant-alerts every N processed frames")
    ap.add_argument("--reconnect", type=int, default=10, help="seconds to wait before reconnecting a live stream")
    ap.add_argument("--once", action="store_true", help="one pass then exit (for file sources / testing)")
    ap.add_argument("--no-email", action="store_true", help="don't send alerts (testing)")
    a = ap.parse_args()

    from ultralytics import YOLO
    embed = build_embedder()
    cen = lc.dome_centroid(embed)
    det = YOLO("yolo11n.pt")
    con = dp.db_connect(a.db)
    con.execute("PRAGMA journal_mode=WAL")      # coexist with the JamCam cron on the shared db
    con.execute("PRAGMA busy_timeout=5000")
    lc.ensure_schema(con)
    cam_id = f"EDGE_{a.name}"
    is_file = (not a.source.isdigit()) and os.path.exists(a.source)
    print(f"edge capture: source={a.source} cam_id={cam_id} db={a.db} "
          f"PROB_TH={lc.PROB_TH} ALERT_TH={lc.ALERT_TH}", flush=True)
    while True:
        try:
            n = run_once(det, embed, cen, con, cam_id, a)
            print(f"stream session ended ({n} frames processed)", flush=True)
        except KeyboardInterrupt:
            break
        except Exception as ex:
            print(f"stream error: {ex}", flush=True)
        if a.once or is_file:
            break
        time.sleep(a.reconnect)   # live stream dropped -> reconnect


if __name__ == "__main__":
    main()
