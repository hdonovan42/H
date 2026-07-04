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
    ap.add_argument("--batch", type=int, default=32,         # GPU chunk: measured sweet spot @704 + P2.
                    help="frames per forward pass. Measured on a 4090 @704: 1->92fps, 32->230fps (3.2GB), "
                         "plateaus after (compute-bound). The list MUST be chunked by hand — ultralytics "
                         "stacks a whole-list source into ONE tensor and OOMs regardless of stream/batch.")
    # SLICE MODE (RUN_3): repeated model.predict() calls leak host RAM (~2 MB/frame — ate 44 GB of a
    # 62 GB box at ~20k frames and wedged it; RUN_2's 503 GB host masked it). Run the sweep as many
    # SUBPROCESSES of --limit frames each (driver loops --skip); memory is returned at process exit
    # whatever the leak mechanism, and per-slice part files make the sweep resumable.
    ap.add_argument("--skip", type=int, default=0, help="skip this many (sorted) present frames")
    ap.add_argument("--limit", type=int, default=0, help="score at most this many frames (0 = all)")
    a = ap.parse_args()

    rows = list(csv.DictReader(open(a.manifest)))
    by_frame = {}                                            # basename -> [manifest rows]
    for r in rows:
        by_frame.setdefault(r["frame_basename"], []).append(r)
    present = sorted(os.path.join(a.frames_dir, b) for b in by_frame if
                     os.path.exists(os.path.join(a.frames_dir, b)))
    sliced = a.skip > 0 or a.limit > 0
    if sliced:
        present = present[a.skip:a.skip + a.limit] if a.limit else present[a.skip:]
    print(f"{len(rows)} candidates / {len(by_frame)} unique frames / "
          f"{len(present)} present{' in slice' if sliced else ' on disk'}")
    if not present:
        open(a.out, "w").close()                             # empty part = past the end; driver stops
        print("empty slice -> wrote empty part")
        return

    from ultralytics import YOLO
    model = YOLO(a.weights)
    verdict = {}                                             # basename -> (conf, bbox, n_dets)
    t0 = time.time()
    # ultralytics collates a whole list/stream source into ONE forward-pass tensor (OOMs on 43k frames),
    # so chunk by hand: each model.predict(chunk) is one real GPU batch of --batch frames. ~2.5x over
    # batch=1 on a 4090 (measured 92->230 fps @704), bounded VRAM (~3 GB at batch 32).
    for i in range(0, len(present), a.batch):
        chunk = present[i:i + a.batch]
        # ultralytics renames batched results image0.jpg, image1.jpg, … (res.path is NOT the input path),
        # so key the verdict off the KNOWN input path via zip — results come back in input order.
        for path, res in zip(chunk, model.predict(chunk, imgsz=a.imgsz, conf=a.conf,
                                                  device=a.device, verbose=False)):
            best_c, best_b = 0.0, None
            for b in res.boxes:
                c = float(b.conf[0])
                if c > best_c:
                    xy = b.xyxy[0].tolist()
                    best_c, best_b = c, [round(xy[0], 1), round(xy[1], 1), round(xy[2], 1), round(xy[3], 1)]
            verdict[os.path.basename(path)] = (round(best_c, 4), best_b, len(res.boxes))
    dt = time.time() - t0
    print(f"scored {len(verdict)} frames in {dt:.0f}s ({len(verdict) / max(dt, 1):.1f} frames/s)")

    slice_bases = {os.path.basename(p) for p in present}
    flds = list(rows[0].keys()) + ["run2_conf", "run2_bbox", "run2_n_dets"]
    with open(a.out, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=flds)
        w.writeheader()
        for base, rs in by_frame.items():
            v = verdict.get(base)                           # absent => frame not on the box
            if sliced and base not in slice_bases:
                # slice mode: this part covers ONLY its own frames. Rows whose frame is missing
                # from disk entirely belong to no slice, so the skip==0 part emits them (once).
                if a.skip != 0 or os.path.exists(os.path.join(a.frames_dir, base)):
                    continue
            for r in rs:
                if v is None:
                    w.writerow(dict(r, run2_conf="", run2_bbox="", run2_n_dets=""))
                else:
                    c, b, n = v
                    w.writerow(dict(r, run2_conf=c, run2_bbox=json.dumps(b) if b else "", run2_n_dets=n))
    print(f"-> {a.out}")


if __name__ == "__main__":
    main()
