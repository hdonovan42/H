#!/usr/bin/env python3
"""Backfill missing Waymo boxes in already-confirmed frames (v0.8.59).

Multi-Waymo frames captured before v0.8.58 could lose same-clip siblings to the appearance
dedup, leaving a real Waymo UNLABELLED in the training frame (which teaches YOLO to SUPPRESS
real Waymos). This re-runs the detector on confirmed frames, surfaces extra white-vehicle boxes
NOT already covered by a confirmed box, and — on human confirmation — inserts them as
status='waymo' rows keyed to the ORIGINAL frame's (camera_id, captured_at), so
build_real_dataset groups them into one multi-box label.

A high dome score is NOT proof (the scorer is weak — the whole reason we collect data), so this
is human-in-loop: --scan emails a numbered sheet; you reply which extra boxes are also Waymos;
--add inserts exactly those.

Backfilled boxes are TRAINING LABELS ONLY: they are NOT copied to real_positives/, so the
surfacer centroid and bars are untouched (no reseed/restart). The frame already surfaced via its
primary Waymo; backfill only completes its YOLO label. (So the DB 'waymo' count then counts
Waymo BOXES, > the real_positives/ centroid-crop count — like the eval_positive gap. Report
boxes vs frames vs centroid precisely; build_real_dataset prints all three.)

Usage:
  backfill_multibox.py --scan 37666[,123,...]   re-detect those confirmed frames
  backfill_multibox.py --scan-all               re-detect EVERY confirmed frame (special IS NULL)
  backfill_multibox.py --add 37666:1[,2] ...    insert chosen extra boxes (from the last scan)
"""
import argparse
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(BASE, "collector"))

import cv2  # noqa: E402
import data_plane as dp  # noqa: E402
from separability_eval import build_embedder, jamcam  # noqa: E402
from live_capture import (detector, roof_crop, is_white, iou, load_centroid,  # noqa: E402
                          CAND_DIR, _build_sheet)
from email_alert import send_email  # noqa: E402

PENDING = os.path.join(CAND_DIR, "backfill_pending.json")
IOU_COVERED = 0.45   # a detection overlapping an existing confirmed box this much = already labelled
# Backfill is HUMAN-GATED, so it relaxes the live surfacer's resolvability floors: the live MIN_H
# (44px) / NEAR_TH gates exist because WE can't tell dome-vs-bar on a small/low view — but here the
# user has already confirmed the frame, and an UNLABELLED true Waymo (even a small one) poisons the
# training frame. So surface smaller/lower-scoring extras and let the human decide; the per-frame cap
# bounds the noise. (A surfaced box the user judges too small/ambiguous to train on, they just skip.)
BACKFILL_MIN_H = 20         # vs live MIN_H 44 — catch distant 2nd Waymos so they aren't left unlabelled
CAP_PER_FRAME = 5           # most extra white vehicles to surface per frame (highest dome score first)


def confirmed_boxes(con, cam, at):
    """Every confirmed-Waymo bbox already on this (camera, captured_at) frame."""
    return [json.loads(bb) for (bb,) in con.execute(
        "SELECT bbox FROM candidates WHERE camera_id=? AND captured_at=? AND status='waymo' "
        "AND bbox IS NOT NULL", (cam, at)).fetchall()]


def scan(con, ids):
    det = detector()
    embed = build_embedder()
    cen = load_centroid()
    pend, sheet_rows = {}, []
    for cid in ids:
        row = con.execute("SELECT camera_id, captured_at, frame_path FROM candidates "
                          "WHERE id=? AND status='waymo'", (cid,)).fetchone()
        if not row:
            print(f"#{cid}: not a confirmed Waymo — skip")
            continue
        cam, at, fp = row
        if not (fp and os.path.exists(fp)):
            print(f"#{cid}: frame missing on disk — skip")
            continue
        frm = cv2.imread(fp)
        if frm is None:
            print(f"#{cid}: frame unreadable — skip")
            continue
        existing = confirmed_boxes(con, cam, at)
        extras = []
        for r in det(frm, classes=[2], conf=0.30, imgsz=352, verbose=False):
            if r.boxes is None:
                continue
            for b in r.boxes:
                x1, y1, x2, y2 = map(int, b.xyxy[0].tolist())
                box = [x1, y1, x2, y2]
                if (y2 - y1) < BACKFILL_MIN_H:
                    continue
                if not is_white(frm[max(0, y1):y2, max(0, x1):x2]):
                    continue
                if any(iou(box, e) > IOU_COVERED for e in existing):
                    continue                                    # already a confirmed box here
                roof = roof_crop(frm, box)
                if roof.size == 0 or min(roof.shape[:2]) < 6:
                    continue
                s = float(embed(jamcam(roof)) @ cen)            # shown for context; no hard floor —
                extras.append((box, s))                         # the human is the filter here
        # collapse overlapping detections of the same vehicle, best score first, then cap the noise
        extras.sort(key=lambda t: -t[1])
        kept = []
        for box, s in extras:
            if not any(iou(box, k[0]) > IOU_COVERED for k in kept):
                kept.append((box, s))
        kept = kept[:CAP_PER_FRAME]
        if not kept:
            print(f"#{cid}: no extra Waymo-like box beyond the {len(existing)} already confirmed")
            continue
        pend[str(cid)] = {"camera_id": cam, "captured_at": at, "frame_path": fp, "boxes": []}
        for n, (box, s) in enumerate(kept, 1):
            hd = int((box[3] - box[1]) * 0.12)
            car = frm[max(0, box[1] - hd):box[3], max(0, box[0]):min(frm.shape[1], box[2])]
            crop_p = os.path.join(CAND_DIR, f"backfill_{cid}_{n}.jpg")
            cv2.imwrite(crop_p, car)
            pend[str(cid)]["boxes"].append({"n": n, "box": box, "score": round(s, 4), "crop": crop_p})
            sheet_rows.append((f"{cid}:{n}", s, crop_p))
            print(f"#{cid}: extra box {n} score {s:.3f} {box} ({len(existing)} already confirmed)")
    json.dump(pend, open(PENDING, "w"))
    if not sheet_rows:
        print("no extra boxes found in any scanned frame")
        return
    out = os.path.join(CAND_DIR, "backfill_sheet.jpg")
    _build_sheet(sheet_rows, out, cap=len(sheet_rows))
    html = ("<p><b>WaymoWatch — backfill: extra vehicles in already-confirmed frames.</b></p>"
            "<p>These boxes sit in frames you've already confirmed but were never captured as their "
            "own candidates (same-clip siblings lost to the old dedup). Reply with the ones that are "
            "ALSO Waymos (white I-PACE, dark roof dome), e.g. <b>add 37666:1</b> — I'll add them as "
            "training boxes for that frame. Anything you don't list is ignored.</p>")
    ok = send_email(f"WaymoWatch: backfill — {len(sheet_rows)} extra box(es) to verify across "
                    f"{len(pend)} frame(s)", html, attachments=[out])
    print(f"sheet emailed: {ok} ({len(sheet_rows)} extra boxes across {len(pend)} frames)")


def add(con, specs):
    if not os.path.exists(PENDING):
        sys.exit("no pending scan — run --scan first")
    pend = json.load(open(PENDING))
    embed = build_embedder()
    added, keep_crops = 0, set()
    for spec in specs:
        cid, _, nums = spec.partition(":")
        if cid not in pend:
            print(f"#{cid}: not in the last scan — skip")
            continue
        info = pend[cid]
        want = {int(x) for x in nums.split(",") if x}
        frm = cv2.imread(info["frame_path"])
        for bx in info["boxes"]:
            if bx["n"] not in want:
                continue
            box = bx["box"]
            e = embed(jamcam(roof_crop(frm, box)))
            con.execute(
                "INSERT INTO candidates(camera_id,captured_at,score,crop_path,frame_path,emb,bbox,status)"
                " VALUES(?,?,?,?,?,?,?,'waymo')",
                (info["camera_id"], info["captured_at"], bx["score"], bx["crop"], info["frame_path"],
                 json.dumps([round(float(x), 4) for x in e]), json.dumps(box)))
            keep_crops.add(bx["crop"])
            added += 1
            print(f"added #{cid}:{bx['n']} -> waymo box on frame "
                  f"({info['camera_id']} {info['captured_at']}) score {bx['score']}")
    con.commit()
    # tidy: drop the pending record + any scan crops that weren't added
    for f in glob.glob(os.path.join(CAND_DIR, "backfill_*.jpg")):
        if f not in keep_crops:
            os.remove(f)
    os.remove(PENDING)
    print(f"backfilled {added} box(es) (training labels only — NOT added to real_positives/centroid). "
          f"Re-run dataset/build_real_dataset.py to fold them into multi-box labels.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", default="", help="comma-separated confirmed ids to re-detect")
    ap.add_argument("--scan-all", action="store_true", help="re-detect EVERY confirmed frame")
    ap.add_argument("--add", nargs="*", default=None, help="ID:n[,n] specs to insert from the last scan")
    a = ap.parse_args()
    con = dp.db_connect(dp.DEFAULT_DB)
    if a.scan_all:
        scan(con, [r[0] for r in con.execute(
            "SELECT id FROM candidates WHERE status='waymo' AND special IS NULL").fetchall()])
    elif a.scan:
        scan(con, [int(x) for x in a.scan.split(",")])
    elif a.add is not None:
        add(con, a.add)
    else:
        ap.error("one of --scan / --scan-all / --add is required")


if __name__ == "__main__":
    main()
