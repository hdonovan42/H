#!/usr/bin/env python3
"""WaymoNet training BENCH harness — sweep one training config and log throughput + quality.

Built to spend idle rented-GPU time finding speedups that apply to every future run. Measures, for
one config: steady-state sec/epoch (median of epochs 2..N, excluding the cold caching epoch), peak
VRAM, and final val mAP50 — appended as one row to a results CSV so a bash sweep can compare configs.

IMPORTANT: run this only when the GPU is otherwise idle. Concurrent runs share the SMs and the
dataloader CPUs, which confounds every timing number here.

  bench.py --name w16 --workers 16 --epochs 4              # throughput probe (4 epochs is enough)
  bench.py --name hw3 --data <variant>/dataset.yaml --epochs 120 --gate-after   # quality run + gate

Same augmentation recipe as train.py so comparisons are fair; patience is disabled (= run exactly
--epochs) so timing isn't cut short. Powered by TfL Open Data.
"""
import argparse
import csv
import json
import os
import time

import torch
from ultralytics import YOLO


def portable_data_path(data_yaml):
    """Repoint the yaml's absolute `path:` at its own dir, so any dataset (incl. hardlinked
    hard-weight variants) trains wherever it sits. Idempotent — mirrors train.py."""
    dy = os.path.abspath(data_yaml)
    ddir = os.path.dirname(dy)
    lines = open(dy).read().splitlines()
    if not any(ln.strip() == f"path: {ddir}" for ln in lines):
        lines = [f"path: {ddir}" if ln.split(":", 1)[0].strip() == "path" else ln for ln in lines]
        open(dy, "w").write("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="/workspace/data/dataset_real/dataset.yaml")
    ap.add_argument("--model", default="yolo26s-p2.yaml")
    ap.add_argument("--weights", default="yolo26s.pt")
    ap.add_argument("--imgsz", type=int, default=704)
    ap.add_argument("--batch", type=int, default=-1, help="-1 = AutoBatch")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--compile", action="store_true")
    ap.add_argument("--mosaic", type=float, default=0.4)
    ap.add_argument("--cache", default="ram")
    ap.add_argument("--name", required=True)
    ap.add_argument("--device", default="0")
    ap.add_argument("--results", default="/workspace/exp_results.csv")
    ap.add_argument("--note", default="")
    a = ap.parse_args()

    portable_data_path(a.data)
    torch.cuda.reset_peak_memory_stats()
    m = YOLO(a.model)
    if a.model.endswith(".yaml") and a.weights:
        m.load(a.weights)

    t0 = time.time()
    r = m.train(
        data=a.data, imgsz=a.imgsz, epochs=a.epochs, batch=a.batch, workers=a.workers,
        device=a.device, compile=a.compile, cache=a.cache, optimizer="auto", cos_lr=True,
        patience=a.epochs + 1, close_mosaic=0, seed=0,
        hsv_h=0.015, hsv_s=0.7, hsv_v=0.4, degrees=3.0, translate=0.05, scale=0.15, shear=2.0,
        perspective=0.0005, fliplr=0.5, flipud=0.0, mosaic=a.mosaic, mixup=0.0, copy_paste=0.0,
        project="/workspace/data/runs", name=a.name, exist_ok=True, plots=False, val=True, verbose=False,
    )
    wall = time.time() - t0

    # steady-state sec/epoch from results.csv ('time' = cumulative s); drop epoch 1 (caching warmup)
    sec_ep = round(wall / a.epochs, 2)
    rd = os.path.join("/workspace/data/runs", a.name, "results.csv")
    if os.path.exists(rd):
        rows = list(csv.DictReader(open(rd)))
        tcol = next((c for c in (rows[0] if rows else {}) if c.strip() == "time"), None)
        if tcol and len(rows) > 2:
            cum = [float(x[tcol]) for x in rows]
            per = sorted(cum[i] - cum[i - 1] for i in range(2, len(cum)))  # epochs 3..N
            if per:
                sec_ep = round(per[len(per) // 2], 2)

    out = {
        "name": a.name, "imgsz": a.imgsz, "batch_req": a.batch, "workers": a.workers,
        "compile": int(a.compile), "mosaic": a.mosaic, "epochs": a.epochs,
        "sec_per_epoch": sec_ep, "peak_vram_gb": round(torch.cuda.max_memory_reserved() / 1e9, 2),
        "val_map50": round(float(r.box.map50), 4), "wall_s": round(wall, 1),
        "data": os.path.basename(os.path.dirname(os.path.abspath(a.data))), "note": a.note,
    }
    print("RESULT " + json.dumps(out))
    newf = not os.path.exists(a.results)
    with open(a.results, "a", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(out))
        if newf:
            w.writeheader()
        w.writerow(out)


if __name__ == "__main__":
    main()
