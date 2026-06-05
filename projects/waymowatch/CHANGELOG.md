# WaymoWatch — Changelog

## v0.2 — High-quality dataset + GPU training recipe (2026-06-05)

- **Domes:** Commons (`Jaguar I-Pace (Waymo)`) + Bing crawl → auto-extracted roof crops,
  deduped → **39 diverse real dome templates** (from 8).
- **Backplates:** broadened to **4,734 frames / 92 cameras** (from 637/12).
- **Positives:** **400** dome composites across 67 source cameras, provenance-tracked (manifest).
- **Dataset:** 1-class `waymo`; in-domain real negatives (matched + plain traffic), ~4:1;
  **by-camera split** (10 feeds held out); 1,629 train / 335 val; QA'd.
- **Separability study:** dome separates easily from ordinary cars, but **Wayve is a genuine
  roof-rack confuser**; ≥90% dome-vs-Wayve can't be cheaply certified (frozen-probe-limited) →
  Wayve kept as hard-negative, ≥90% is a POST-TRAIN gate (`train/eval_wayve_gate.py`).
- **GPU recipe:** `train/train.py` (YOLO11s, imgsz1280, small-object-safe aug, ONNX export) +
  `train/RUNBOOK.md`. Validated end-to-end by the CPU smoke train (val P0.79 / mAP50 0.39).
- New scripts: dataset/{extract_domes,extract_roofs,crawl_images,wayve_fetch,build_dataset,
  separability,separability_eval,separability_scale_eval}.py; train/{train,eval_wayve_gate}.py.

## v0.1 — Data plane + synthetic-positive engine (2026-06-03)

First working slice. Detect-and-train infrastructure not built yet; this proves the two
hardest unknowns are tractable.

### What works (verified live with OpenCV, no GPU)
- **Collector** (`collector/data_plane.py`): enumerates all **882** TfL JamCams (779 available),
  conditional-GETs each camera's ~11s H.264 clip from S3 (ETag dedup), decodes with OpenCV,
  extracts frames at a configurable sample rate, records cameras/clips/frames in SQLite.
  - Baseline: 12 central cams → 12 clips, 637 frames in ~70s (single-threaded → needs
    parallelism at 779-cam scale).
- **Source imagery** (`dataset/fetch_sources.py`): 28 CC-licensed images from Wikimedia Commons —
  1 clean Waymo dome reference + many ordinary I-PACEs (negatives). Manifest records per-image licence.
- **Copy-paste engine** (`dataset/copy_paste.py`): `jamcam_degrade`, `composite`, `simulate_at_scale`.
- **Synthetic positives** (`dataset/make_synthetic.py`): detect cars (YOLO11n COCO) in real London
  backplates → paste a real Waymo dome on resolvable-size roofs (≥30px, aspect-ratio gated) →
  brightness-match + feather → re-degrade to JamCam JPEG → emit YOLO labels. **80 positives generated.**

### Baseline facts to watch
- TfL clip = 25fps / ~11s / 277 frames / 352×288, refreshed ~3–8 min. Full video sweep ≈ 216k
  frames/3min → sample every 5th (56f/clip) → 242fps required → needs 1 small GPU (Phase 5).
- **Dome resolvable only when host vehicle ≳45px tall** (`data/sources/dome_scale_test.jpg`).
- No off-the-shelf dataset/model fits (ego-viewpoint or non-commercial). Our JamCam frames + the
  copy-paste engine are the data strategy.

### Next
- Harvest more dome crops via yt-dlp/ffmpeg (YouTube/news) for angle variety.
- Generate matched negatives; assemble dataset.yaml (2 classes: waymo, wayve).
- Autolabel pipeline (YOLOE proposer + Claude dome/bar classifier) for real frames.
- Train WaymoNet v0 (YOLO11s + P2 head) on a rented 4090; eval by held-out clip; ship-gate P≥0.9.
- Two-stage inference runtime + Leaflet sighting feed + WhatsApp alerts.
