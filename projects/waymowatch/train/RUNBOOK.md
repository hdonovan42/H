# WaymoNet v1 — GPU training runbook

Trains the 1-class (`waymo`) dome detector on a rented GPU. The dataset is already
de-risked, de-duped, honestly split (by camera), and QA'd. Budget ~$1 and ~1–2 h.

## 0. What you're training on
- **Positives:** 400 synthetic dome composites (39 deduped real domes pasted onto real
  London JamCam cars), provenance-tracked.
- **Negatives:** in-domain real JamCam frames (matched source frames + plain traffic across
  92 cameras — naturally includes cabs/buses/vans), ~4:1 neg:pos.
- **Split:** 10 camera feeds fully held out for val (no scene/camera leakage).

## 1. Rent a GPU
RunPod or Vast.ai, a single **RTX 4090 (24 GB)** (~$0.29–0.34/hr). A100 is overkill.

## 2. Get the code + data onto the box
```bash
git clone <repo> && cd H && git checkout waymowatch
# data/ is gitignored — transfer the prepared dataset (or regenerate it, see §6):
rsync -av projects/waymowatch/data/dataset/ <box>:.../projects/waymowatch/data/dataset/
rsync -av projects/waymowatch/data/sources/wayve_rack/ <box>:.../wayve_rack/   # for the gate
rsync -av projects/waymowatch/data/synthetic/manifest.json <box>:.../synthetic/
python -m venv .venv && .venv/bin/pip install ultralytics torch torchvision  # CUDA build
```

## 3. Train
```bash
.venv/bin/python projects/waymowatch/train/train.py --device 0 --epochs 120 --imgsz 1280
```
Outputs weights + ONNX under `projects/waymowatch/data/runs/waymonet_v1/`.

## 4. Read the eval honestly
- `train.py` prints **val mAP@50 / mAP@50-95** on the 10 held-out feeds. Note: val positives
  are still *synthetic* (no real London Waymos yet), so this proves generalisation across
  unseen cameras, not real-world recall.
- Pick the confidence operating point for **precision ≥ 0.9** from the PR curve in
  `data/runs/waymonet_v1/`.

## 5. Run the Waymo-vs-Wayve acceptance gate
```bash
.venv/bin/python projects/waymowatch/train/eval_wayve_gate.py \
    --weights projects/waymowatch/data/runs/waymonet_v1/weights/best.pt --conf 0.25
```
Pastes Wayve roof-racks onto held-out backplates and measures Waymo-recall vs Wayve-false-positive.
- **≥90% balanced ⇒** Wayve is cleanly separable — promote it to an explicit class in v2.
- **<90% ⇒** keep Wayve as a hard-negative, restrict confident calls to near-field/large
  vehicles, and let the human-confirm queue catch the rest (the planned design).

## 6. (Optional) regenerate the dataset from scratch
```bash
.venv/bin/python collector/data_plane.py --cameras 80 --area central   # backplates
.venv/bin/python dataset/fetch_sources.py && dataset/extract_domes.py   # + crawl_images.py for more
.venv/bin/python dataset/make_synthetic.py && dataset/build_dataset.py
```

## 7. Enhancements to try if recall on small domes is low
- Add a **P2 (stride-4) head** to the model cfg (`--model yolo11s-p2.yaml`) — preserves the
  high-res feature map a ~10px dome needs. (Not shipped by default; validate it builds first.)
- **SAHI / tiled inference** at deploy time on candidate frames.
- Grow real positives via the live-capture loop, then mix real + synthetic and re-eval on real.

> Powered by TfL Open Data.
