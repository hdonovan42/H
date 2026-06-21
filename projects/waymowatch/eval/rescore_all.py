#!/usr/bin/env python3
"""RUN_2 full rescore — run the freshly-trained best.pt over EVERY candidate frame on the GPU box.

Attaches to the end of the training job (train -> gate -> THIS): the weights are already here, the
frames are staged, the rented GPU is otherwise idle, and on a 4090 this is minutes vs ~5-9 h on the
homebox. Reads the manifest exported on the VPS (eval/export_score_manifest.py), scores each unique
frame ONCE with the model's highest-conf box anywhere in the frame (same rule as waymonet_worker.py),
and writes the manifest back enriched with run2_conf / run2_bbox / run2_n_dets. Pull the output to the
VPS and feed it to eval/run2_report.py.

  /venv/main/bin/python rescore_all.py --weights <run>/weights/best.pt \\
      --frames-dir /workspace/candidates --manifest run2_manifest.csv \\
      --out run2_scored.csv --device 0

Powered by TfL Open Data.
"""
import argparse
import csv
import json
import os
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True)
    ap.add_argument("--frames-dir", required=True, help="dir holding the candidate *_frame.jpg")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--imgsz", type=int, default=704)        # MUST match training resolution
    ap.add_argument("--conf", type=float, default=0.03)      # = COLLECT_FLOOR; thresholds applied offline
    ap.add_argument("--device", default="0")
    a = ap.parse_args()

    rows = list(csv.DictReader(open(a.manifest)))
    by_frame = {}                                            # basename -> [manifest rows]
    for r in rows:
        by_frame.setdefault(r["frame_basename"], []).append(r)
    present = [os.path.join(a.frames_dir, b) for b in by_frame if
              os.path.exists(os.path.join(a.frames_dir, b))]
    print(f"{len(rows)} candidates / {len(by_frame)} unique frames / {len(present)} present on disk")

    from ultralytics import YOLO
    model = YOLO(a.weights)
    verdict = {}                                             # basename -> (conf, bbox, n_dets)
    t0 = time.time()
    # stream=True => generator (one result at a time): bounded memory, GPU-batched internally
    for res in model.predict(present, imgsz=a.imgsz, conf=a.conf, device=a.device,
                             stream=True, verbose=False):
        best_c, best_b = 0.0, None
        for b in res.boxes:
            c = float(b.conf[0])
            if c > best_c:
                xy = b.xyxy[0].tolist()
                best_c, best_b = c, [round(xy[0], 1), round(xy[1], 1), round(xy[2], 1), round(xy[3], 1)]
        verdict[os.path.basename(res.path)] = (round(best_c, 4), best_b, len(res.boxes))
    dt = time.time() - t0
    print(f"scored {len(verdict)} frames in {dt:.0f}s ({len(verdict) / max(dt, 1):.1f} frames/s)")

    flds = list(rows[0].keys()) + ["run2_conf", "run2_bbox", "run2_n_dets"]
    with open(a.out, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=flds)
        w.writeheader()
        for base, rs in by_frame.items():
            v = verdict.get(base)                           # absent => frame not on the box
            for r in rs:
                if v is None:
                    w.writerow(dict(r, run2_conf="", run2_bbox="", run2_n_dets=""))
                else:
                    c, b, n = v
                    w.writerow(dict(r, run2_conf=c, run2_bbox=json.dumps(b) if b else "", run2_n_dets=n))
    print(f"-> {a.out}")


if __name__ == "__main__":
    main()
