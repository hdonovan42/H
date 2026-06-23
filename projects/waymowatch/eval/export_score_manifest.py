#!/usr/bin/env python3
"""Export the RUN_2 rescore manifest from waymo.db (run on the VPS).

One row per candidate that still has a frame on disk, carrying its CURRENT RUN_1 verdict
(wn_conf/wn_hit) frozen at export time. Ship this CSV + the candidate frames to the GPU box;
`eval/rescore_all.py` adds run2_conf for a like-for-like RUN_1-vs-RUN_2 comparison, and
`eval/run2_report.py` turns it into the contradiction report.

  .venv/bin/python eval/export_score_manifest.py --out /tmp/run2_manifest.csv

Powered by TfL Open Data.
"""
import argparse
import csv
import os
import sqlite3

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(BASE, "data", "waymo.db"))
    ap.add_argument("--out", default="/tmp/run2_manifest.csv")
    a = ap.parse_args()
    con = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True, timeout=60)
    n = 0
    with open(a.out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "camera_id", "captured_at", "status", "special", "dome_score",
                    "run1_conf", "run1_hit", "frame_basename"])
        for cid, cam, at, st, sp, sc, c1, h1, fp in con.execute(
                "SELECT id,camera_id,captured_at,status,special,score,wn_conf,wn_hit,frame_path "
                "FROM candidates WHERE frame_path IS NOT NULL"):
            if not (fp and os.path.exists(fp)):
                continue
            w.writerow([cid, cam, at, st, sp, sc, c1, h1, os.path.basename(fp)])
            n += 1
    print(f"manifest -> {a.out} ({n} candidates with frames)")


if __name__ == "__main__":
    main()
