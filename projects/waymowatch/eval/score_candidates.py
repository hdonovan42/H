#!/usr/bin/env python3
"""Score WaymoWatch candidates with the trained WaymoNet model — LOCALLY.

Pulls the chosen candidates' full frames from the VPS (read-only; does NOT touch
the live capture loop) and runs the trained detector (`best.pt`) over them, then
reports which candidates the model calls a Waymo, with confidences.

Per-candidate verdict (same rule as train/eval_gate.py): a model detection that
IoU-matches (>= IOU_MATCH) the candidate's stored host bbox at conf >= the report
threshold. A detection elsewhere in the frame that matches no candidate bbox is
surfaced separately as an "extra" Waymo (one the funnel's box may have missed).

Nothing here writes to the DB or runs on the VPS GPU-side — frames are copied
down once (rsync, only missing files) and all inference is local CPU/GPU.

Examples
--------
  # Default = the "since 13:58" batch: 800 most-recent emailed `new` rows + all unsent `new`
  ./score_candidates.py

  # A specific candidate or set
  ./score_candidates.py --ids 39921,39922,39923

  # Everything captured after a UTC instant
  ./score_candidates.py --captured-after 2026-06-20T13:00:00Z

  # Re-run on the already-downloaded frames (skip the rsync)
  ./score_candidates.py --no-fetch

  # Also draw an annotated contact sheet of the flagged frames
  ./score_candidates.py --sheet

Powered by TfL Open Data.
"""
import argparse
import base64
import csv as csvmod
import gc
import json
import os
import subprocess
import sys
import time

import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)                       # projects/waymowatch
CACHE = os.path.join(HERE, "_cache")               # mirror of pulled VPS frames (gitignored)
OUTDIR = os.path.join(HERE, "out")                 # csv / sheets (gitignored)

HOST = "hq@vps-hel1"                                # tailnet-only SSH (see memory: vps-tailscale)
REMOTE_DIR = "waymowatch"
REMOTE_DB = "data/waymo.db"

DEFAULT_WEIGHTS = os.path.expanduser("~/waymonet_run1/weights/best.pt")
IMGSZ = 704            # MUST match training resolution (Run 1 trained @704)
CONF_FLOOR = 0.05      # single low-conf inference pass; thresholds applied offline
IOU_MATCH = 0.30       # same as train/eval_gate.py
REPORT_CONF = 0.10     # gate operating point (Run 1: 96.3% recall / 100% prec / 0 FP)

# ---------------------------------------------------------------------------
# 1. Candidate selection (read-only query on the VPS DB, run over SSH)
# ---------------------------------------------------------------------------

# This program text is piped to the VPS python over SSH stdin; its only argument
# (argv[1]) is a base64-encoded JSON spec. It opens the live DB READ-ONLY so it
# can never block or corrupt the running loop, and prints the rows as JSON.
_REMOTE_QUERY = r'''
import base64, json, sqlite3, sys
spec = json.loads(base64.b64decode(sys.argv[1]).decode())
con = sqlite3.connect("file:%s?mode=ro" % spec["db"], uri=True, timeout=60)
con.row_factory = sqlite3.Row
COLS = "id,camera_id,captured_at,score,frame_path,bbox,status,sent"
seen, out = set(), []
def add(sql, args=()):
    for r in con.execute("SELECT %s FROM candidates WHERE %s" % (COLS, sql), args):
        if r["id"] in seen:
            continue
        seen.add(r["id"]); out.append({k: r[k] for k in r.keys()})
after = spec.get("captured_after")
if spec.get("frame_paths"):
    fps = spec["frame_paths"]
    for i in range(0, len(fps), 500):                  # stay under SQLite var limit
        chunk = fps[i:i + 500]
        add("frame_path IN (%s)" % ",".join("?" * len(chunk)), tuple(chunk))
elif spec.get("ids"):
    qs = ",".join("?" * len(spec["ids"]))
    add("id IN (%s)" % qs, tuple(spec["ids"]))
else:
    cap = " AND captured_at >= ?" if after else ""
    capargs = (after,) if after else ()
    if spec.get("n_sent"):
        add("status='new' AND sent=1" + cap + " ORDER BY id DESC LIMIT ?",
            capargs + (spec["n_sent"],))
    if spec.get("include_unsent"):
        add("status='new' AND COALESCE(sent,0)=0" + cap, capargs)
    if spec.get("extra_status"):
        add("status=?" + cap, (spec["extra_status"],) + capargs)
print(json.dumps(out))
'''


def select_rows(spec):
    payload = base64.b64encode(json.dumps({**spec, "db": REMOTE_DB}).encode()).decode()
    cmd = ["ssh", HOST, f"cd {REMOTE_DIR} && .venv/bin/python - {payload}"]
    p = subprocess.run(cmd, input=_REMOTE_QUERY, capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(f"remote query failed:\n{p.stderr}")
    rows = json.loads(p.stdout)
    for r in rows:
        r["bbox"] = json.loads(r["bbox"]) if r["bbox"] else None
    return rows


# ---------------------------------------------------------------------------
# 2. Frame fetch (rsync, only missing files; read-only on the VPS)
# ---------------------------------------------------------------------------

def local_frame(remote_path):
    """Local mirror path for a VPS absolute frame_path."""
    return os.path.join(CACHE, remote_path.lstrip("/"))


def fetch_frames(rows):
    os.makedirs(CACHE, exist_ok=True)
    rels = sorted({r["frame_path"].lstrip("/") for r in rows if r.get("frame_path")})
    listfile = os.path.join(CACHE, "_files.txt")
    with open(listfile, "w") as fh:
        fh.write("\n".join(rels) + "\n")
    print(f"rsync: {len(rels)} frames from {HOST} (missing only) …")
    # exit 23 = some source files vanished (pruned by 7-day retention) — tolerate.
    r = subprocess.run(
        ["rsync", "-az", "--ignore-missing-args", f"--files-from={listfile}",
         f"{HOST}:/", CACHE + "/"],
        capture_output=True, text=True)
    if r.returncode not in (0, 23):
        sys.exit(f"rsync failed ({r.returncode}):\n{r.stderr}")


# ---------------------------------------------------------------------------
# 3. Inference + IoU matching
# ---------------------------------------------------------------------------

def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


PROGRESS = os.path.join(OUTDIR, "progress.csv")     # durable per-frame checkpoint (resumable)


def _oom_self_protect():
    """Make the kernel OOM-killer prefer THIS process. Per-frame inference keeps RSS
    ~0.6 GB so it should never spike, but if it ever did we kill ourselves, never the
    surrounding session (the original list-mode run hit 15 GB and took WSL down)."""
    try:
        with open("/proc/self/oom_score_adj", "w") as f:
            f.write("800")
    except Exception:
        pass


def run_model(rows, weights, fresh=False):
    os.makedirs(OUTDIR, exist_ok=True)
    _oom_self_protect()
    # group candidates by the physical frame file (usually 1:1, but multi-track
    # clips can share) so a single inference covers every candidate in that frame
    by_frame, by_id, missing = {}, {}, 0
    for r in rows:
        by_id[r["id"]] = r
        lp = local_frame(r["frame_path"])
        if not os.path.exists(lp):
            missing += 1
            r["_skipped"] = True
            continue
        by_frame.setdefault(os.path.realpath(lp), []).append(r)
    if missing:
        print(f"  note: {missing} frame(s) not on disk (pruned/unavailable) — skipped")
    if not by_frame:
        sys.exit("no frames available to score")

    # resume: pull any prior checkpoint back into the in-memory rows
    done_ids = set()
    if os.path.exists(PROGRESS) and not fresh:
        for d in csvmod.DictReader(open(PROGRESS)):
            rid = int(d["id"])
            if rid in by_id:
                r = by_id[rid]
                r["model_conf"] = float(d["model_conf"])
                r["n_dets"] = int(d["n_frame_dets"])
                r["extra_confs"] = [float(x) for x in d["extra_confs"].split("|") if x]
                done_ids.add(rid)
        if done_ids:
            print(f"  resume: {len(done_ids)} candidate(s) already scored — skipping")

    todo = [(p, cs) for p, cs in by_frame.items()
            if any(c["id"] not in done_ids for c in cs)]
    if not todo:
        print("  all selected candidates already scored (from checkpoint)")
        return

    from ultralytics import YOLO
    print(f"model: {weights}  (imgsz={IMGSZ}, conf-floor={CONF_FLOOR}) | "
          f"{len(todo)} frame(s) to score, one at a time")
    model = YOLO(weights)

    new_file = fresh or not os.path.exists(PROGRESS)
    fh = open(PROGRESS, "w" if new_file else "a", buffering=1)   # line-buffered = durable
    if new_file:
        fh.write("id,camera_id,captured_at,dome_score,sent,model_conf,n_frame_dets,extra_confs\n")

    t0 = time.time()
    for done, (path, cands) in enumerate(todo, 1):
        # ONE image per predict() call — bounded memory; never a list (that leaked to 15 GB)
        res = model.predict(path, imgsz=IMGSZ, conf=CONF_FLOOR, verbose=False)[0]
        dets = [(float(b.conf[0]), tuple(b.xyxy[0].tolist())) for b in res.boxes]
        del res
        matched = set()
        for r in cands:
            best_conf, best_i = 0.0, -1
            for i, (cf, bb) in enumerate(dets):
                if r["bbox"] and iou(r["bbox"], bb) >= IOU_MATCH and cf > best_conf:
                    best_conf, best_i = cf, i
            r["model_conf"] = best_conf
            r["n_dets"] = len(dets)
            if best_i >= 0:
                matched.add(best_i)
        # detections in this frame matching NO candidate bbox = extra Waymo finds
        extra = sorted((cf for i, (cf, _) in enumerate(dets) if i not in matched), reverse=True)
        for r in cands:
            r["extra_confs"] = extra
            fh.write(f"{r['id']},{r['camera_id']},{r['captured_at']},{r['score']:.4f},"
                     f"{r['sent']},{r['model_conf']:.4f},{r['n_dets']},"
                     f"{'|'.join(f'{x:.4f}' for x in extra)}\n")
        if done % 50 == 0:
            gc.collect()
            print(f"  … {done}/{len(todo)} frames ({(time.time()-t0):.0f}s)")
    fh.close()
    print(f"  scored {len(todo)} frames in {(time.time()-t0):.0f}s")


# ---------------------------------------------------------------------------
# 4. Reporting
# ---------------------------------------------------------------------------

def report(rows, conf, sheet):
    scored = [r for r in rows if "model_conf" in r]
    hits = sorted([r for r in scored if r["model_conf"] >= conf],
                  key=lambda r: r["model_conf"], reverse=True)
    # extra (unmatched) Waymo detections in the scored frames
    extra_frames = [r for r in scored
                    if any(cf >= conf for cf in r.get("extra_confs", []))
                    and r["model_conf"] < conf]

    print("\n" + "=" * 72)
    print(f"WaymoNet verdict  |  {len(scored)} candidates scored  |  report conf >= {conf}")
    print("=" * 72)
    if hits:
        print(f"\n  {len(hits)} candidate(s) detected as WAYMO "
              f"(model box IoU>={IOU_MATCH} on the candidate's own vehicle):\n")
        print(f"    {'#id':>7}  {'model':>6}  {'dome':>5}  {'sent':>4}  "
              f"{'camera':<14} captured_at")
        for r in hits:
            print(f"    {r['id']:>7}  {r['model_conf']:>6.3f}  {r['score']:>5.3f}  "
                  f"{'Y' if r['sent'] else 'n':>4}  {r['camera_id']:<14} {r['captured_at']}")
    else:
        print("\n  no candidate matched its own vehicle as a Waymo at this conf.")

    if extra_frames:
        print(f"\n  + {len(extra_frames)} frame(s) where the model found a Waymo NOT on the "
              f"candidate's tagged vehicle\n    (possible funnel miss — eyeball these):")
        for r in sorted(extra_frames, key=lambda r: max(r['extra_confs']), reverse=True):
            print(f"    {r['id']:>7}  extra={max(r['extra_confs']):.3f}  "
                  f"{r['camera_id']:<14} {r['captured_at']}")

    # conf sweep over the scored set
    print("\n  conf sweep (candidates flagged at each threshold):")
    for c in (0.10, 0.15, 0.25, 0.40, 0.50):
        n = sum(1 for r in scored if r["model_conf"] >= c)
        print(f"    >= {c:.2f} : {n}")

    # CSV (final deliverable, sorted best-first)
    os.makedirs(OUTDIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    csv_out = os.path.join(OUTDIR, f"scored_{stamp}.csv")
    with open(csv_out, "w") as fh:
        fh.write("id,camera_id,captured_at,dome_score,sent,model_conf,is_waymo,"
                 "n_frame_dets,extra_waymo_conf\n")
        for r in sorted(scored, key=lambda r: r["model_conf"], reverse=True):
            ex = max(r.get("extra_confs", [0]) or [0])
            fh.write(f"{r['id']},{r['camera_id']},{r['captured_at']},{r['score']:.4f},"
                     f"{r['sent']},{r['model_conf']:.4f},"
                     f"{int(r['model_conf'] >= conf)},{r['n_dets']},{ex:.4f}\n")
    print(f"\n  CSV: {csv_out}")

    if sheet and hits:
        path = _contact_sheet(hits, conf, stamp)
        print(f"  sheet: {path}")
    print()
    return hits


def _contact_sheet(hits, conf, stamp):
    """Annotated grid of the flagged frames (model box + id + conf), for eyeballing."""
    import numpy as np
    cols, cell = 5, 240
    rows_n = (len(hits) + cols - 1) // cols
    sheet = np.full((rows_n * cell, cols * cell, 3), 30, np.uint8)
    for k, r in enumerate(hits):
        im = cv2.imread(local_frame(r["frame_path"]))
        if im is None:
            continue
        h, w = im.shape[:2]
        if r["bbox"]:
            x1, y1, x2, y2 = (int(v) for v in r["bbox"])
            cv2.rectangle(im, (x1, y1), (x2, y2), (0, 230, 0), 1)
        scale = cell / max(h, w)
        im = cv2.resize(im, (int(w * scale), int(h * scale)))
        ih, iw = im.shape[:2]
        gy, gx = (k // cols) * cell, (k % cols) * cell
        sheet[gy:gy + ih, gx:gx + iw] = im
        cv2.putText(sheet, f"#{r['id']} {r['model_conf']:.2f}", (gx + 3, gy + cell - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1, cv2.LINE_AA)
    os.makedirs(OUTDIR, exist_ok=True)
    path = os.path.join(OUTDIR, f"hits_{stamp}.jpg")
    cv2.imwrite(path, sheet)
    return path


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Score WaymoWatch candidates with WaymoNet (local).")
    ap.add_argument("--ids", help="comma-separated candidate ids (overrides scope flags)")
    ap.add_argument("--n-sent", type=int, default=800,
                    help="most-recent emailed `new` rows to include (default 800 = the 13:58 batch)")
    ap.add_argument("--no-unsent", action="store_true", help="exclude the still-unsent `new` pool")
    ap.add_argument("--captured-after", help="only rows with captured_at >= this (UTC, e.g. 2026-06-20T13:00:00Z)")
    ap.add_argument("--include-near", action="store_true", help="also score status='near' (sub-bar archive)")
    ap.add_argument("--weights", default=DEFAULT_WEIGHTS)
    ap.add_argument("--conf", type=float, default=REPORT_CONF, help="report threshold (default 0.10)")
    ap.add_argument("--no-fetch", action="store_true", help="skip rsync, use cached frames")
    ap.add_argument("--fresh", action="store_true",
                    help="ignore the checkpoint and re-score from scratch")
    ap.add_argument("--cached", action="store_true",
                    help="score exactly the frames already in eval/_cache (implies --no-fetch); "
                         "drift-proof — scores the batch as it was pulled")
    ap.add_argument("--sheet", action="store_true", help="also write an annotated contact sheet of hits")
    a = ap.parse_args()

    if a.cached:
        rels = []
        for dirpath, _, files in os.walk(CACHE):
            rels += [os.path.join(dirpath, f) for f in files if f.endswith("_frame.jpg")]
        # local cache path -> VPS absolute frame_path
        spec = {"frame_paths": ["/" + os.path.relpath(p, CACHE) for p in rels]}
        a.no_fetch = True
        print(f"--cached: {len(spec['frame_paths'])} frames in {CACHE}")
    elif a.ids:
        spec = {"ids": [int(x) for x in a.ids.split(",") if x.strip()]}
    else:
        spec = {"n_sent": a.n_sent, "include_unsent": not a.no_unsent,
                "captured_after": a.captured_after,
                "extra_status": "near" if a.include_near else None}

    rows = select_rows(spec)
    if not rows:
        sys.exit("no candidates matched the selection")
    n_sent = sum(1 for r in rows if r["sent"])
    print(f"selected {len(rows)} candidates  ({n_sent} sent, {len(rows) - n_sent} unsent)")

    if not a.no_fetch:
        fetch_frames(rows)
    run_model(rows, a.weights, fresh=a.fresh)
    report(rows, a.conf, a.sheet)


if __name__ == "__main__":
    main()
