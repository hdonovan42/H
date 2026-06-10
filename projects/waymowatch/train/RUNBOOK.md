# WaymoNet — GPU training runbook (REAL data, v2 recipe)

The synthetic-era recipe is retired. The model trains on what the live system banks:
user-confirmed Waymos (frame + bbox = detector-grade labels) and user-rejected frames
(human-vetted hard negatives that fooled the surfacer). No synthetic composites anywhere.

## The roadmap this run sits in
1. **Find** — the live 484-cam zone loop surfaces candidates; user confirms the first real
   Waymo(s) from the ranked digests. *(running now)*
2. **Recalibrate** — `dataset/reseed_from_real.py` re-anchors the cosine scorer + thresholds
   on the confirmed real crops; mine the near archive (±45 min) for extra passes. The
   surfacer's precision jumps, so confirms accelerate.
3. **Collect** — run the recalibrated loop until confirms reach **~100+ across ≥5 cameras**
   (rejects keep accruing as hard negatives for free). Below that, a detector memorises.
4. **Train (this runbook)** — YOLO26s-P2 on the real dataset → acceptance gate → prod ONNX.

## 0. Build the dataset (on the VPS — that's where waymo.db and the jpgs live)
```bash
cd /home/hq/waymowatch && .venv/bin/python dataset/build_real_dataset.py
# -> data/dataset_real/  (positives + vetted hard negatives, by-camera split)
```

## 1. Pre-flight on CPU — never debug at $0.34/hr
```bash
.venv/bin/python train/preflight.py     # exit 0 = dataset + model + forward pass all good
```

## 2. Rent + setup
Single RTX 4090 (24 GB), RunPod/Vast (~$0.30/hr; expect 20–40 min wall with cache+704).
```bash
git clone <repo> && cd H && git checkout waymowatch
python -m venv .venv && .venv/bin/pip install 'ultralytics==8.4.63'   # pinned = reproducible
rsync -av <vps>:/home/hq/waymowatch/data/dataset_real/ projects/waymowatch/data/dataset_real/
```

## 3. Train
```bash
.venv/bin/python projects/waymowatch/train/train.py --device 0
```
Defaults: **yolo26s-p2.yaml + yolo26s.pt transfer, imgsz 704, batch auto, cache=ram,
mosaic 0.4 / scale 0.15** (mosaic at 1.0 pushed the dome below the measured resolvability
floor), 150 epochs / patience 30. Why not 1280: source is 352×288 — 1280 is 3× the compute
spent on interpolation; 704 + the P2 stride-4 head sees the dome at the same effective
resolution. `yolo11s-p2.yaml` does NOT exist in ultralytics (old runbook bug); yolo26s-p2
builds and accepts COCO transfer — verified on CPU 2026-06-10.

## 4. The ship decision = the gate, not mAP
```bash
.venv/bin/python projects/waymowatch/train/eval_gate.py \
    --weights projects/waymowatch/data/runs/waymonet_real_v1/weights/best.pt
```
Held-out-camera recall (IoU-matched to the labelled box — stray detections don't count) vs
FP rate on held-out human-vetted negatives, swept over confidence. **Ship bar: precision
≥ 0.9 at usable recall**; below it, the model still serves the human queue, not alerts.
Real rejected Wayves are inside the negative set, so Wayve discrimination is tested on real
data automatically.

## 5. Deploy
ONNX exports at the training imgsz; re-export at the serving resolution once Phase-5
inference (TensorRT) fixes one — accuracy must be validated AT the serving size.

> Powered by TfL Open Data.
