# WaymoWatch — Changelog

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
