# WaymoWatch — spot & log Waymo test vehicles from TfL JamCams

Train **WaymoNet** (a fine-tuned YOLO) to spot Waymo's London test fleet (roof-lidar
Jaguar I-PACEs) in TfL traffic-camera *video clips*, log confirmed sightings, produce
analytics. **Sighting-feed-first.** Honest scope: high-precision / modest-recall feed of
human-gated rare candidates — NOT a live fleet tracker (days between sightings early on).

## Verified facts (do not re-research)
- Waymo IS in London (mid-2026): LHD white Jaguar I-PACE, roof lidar **dome**, ~tens→~100
  vehicles, 20 boroughs, Park Royal depot. **DOME=Waymo, flat roof BAR=Wayve/Uber** is the
  ONLY low-res discriminator (Wayve also uses I-PACEs → base model is useless).
- TfL JamCam: 882 cams (779 available). `videoUrl` = H.264 **25fps / ~11s / 277f / 352×288**
  clip, refreshed ~3–8 min. ETag conditional-GET. OGL v2, plate/face-free, ML-OK.
- **No off-the-shelf dataset/model fits** (all ego-viewpoint or non-commercial). Our own JamCam
  frames are the best data. Waymo Open Dataset / WayveScenes101 / Getty = legally OFF-LIMITS.
- Capacity: full sweep 779×277≈216k frames/3min. Sample every 5th (56f/clip, 43.6k, 242fps).
  CPU VPS can't keep up (~612s); needs 1 small always-on GPU (T4 ~$110/mo, 3090 ~$168/mo) — Phase 5.
- Dome is 5–15px → resolvable near/mid-field only → **per-clip detection** + within-clip ByteTrack.

## Decisions
- Model: **1-class waymo (dome)**, serve only waymo. Wayve = **hard NEGATIVES** (label-less), NOT a
  positive class (can't certify ≥90% dome-vs-Wayve yet; we serve only waymo anyway). Hard negatives =
  Wayve roof-racks + protruding roof structures (cab signs, roof boxes, lightbars). ≥90% dome-vs-Wayve
  = POST-TRAIN acceptance gate. [revised twice — Wayve is a real roof-rack confuser, not flat]
- **ARCHITECTURE PIVOT (user insight): two-stage cascade.** Stage 1 = cheap white-car colour filter
  (Waymos are white → discard ~80% of traffic, `is_white()` in live_capture). Stage 2 = **binary
  classifier** white-Waymo vs white-non-Waymo on REAL JamCam whole-car crops. Simpler than the
  synthetic YOLO detector, less data, higher effective resolution on the crop, and viewpoint-correct
  (real on-angle data → fixes the synthetic gap). Data self-collected by the live loop: negatives =
  harvested/rejected whites (120 staged, stratified hard-weighted, vetted), positives = confirmed real
  Waymos via King's Cross capture. Train when ~30–40+ real positives exist. [decided]
- Labelling: minimal-first (~150 mostly-synthetic positives + ~1.5k negs) → mine live FPs. [decided]
- Alerts: only above precision≥0.9 op-point; rest to human-confirm queue. [decided]
- Scope: **personal/hobby** → wide data-sourcing latitude; YOLO AGPL is a non-issue. [decided]
- Dome sourcing: **Wikimedia Commons + Waymo press + icrawler crawl**; filter by MANUAL visual review
  (contact sheets I inspect) — **no Claude-vision API** (avoid unnecessary calls). [decided]
- Crop strategy: **dome-only**, pasted onto our own JamCam backplates (keeps host viewpoint correct). [decided]
- Path: **recommended bootstrap** — provenance fix → harvest domes → 2-class dataset → train v0;
  autolabel pipeline built AFTER v0 (proposer=yolo11n car+roof, adjudicator=Claude later, gate=custom :3104 page). [decided]
- Inference host: always-on cheap GPU vs hourly burst — **decide at Phase 5** (~$110–170/mo). [OPEN]

## Findings
- **Dome resolvable only when host vehicle ≳45px tall** (near/mid field); marginal ~30px; lost ≤20px
  (measured: `data/sources/dome_scale_test.jpg`). → gate detection on vehicle size; per-clip detection.
- **Waymo dome separates EASILY from ordinary flat-roof cars** (distinct dark protrusion to ~34px;
  smoke detector P=0.79 vs ordinary London traffic).
- **CORRECTION — Wayve IS a genuine confuser**, not an easy negative: Wayve carries a roof sensor
  RACK/BAR (not flat). Dome-vs-Wayve could NOT be certified ≥90% by a cheap frozen-embedding probe
  (~84% even full-res) — but that's a DATA/probe limit: only **8 real Waymo dome images**, so CV is too
  noisy to trust. **Real blocker = too few Waymo domes.** → harvest more domes; treat ≥90% dome-vs-Wayve
  as a POST-TRAIN acceptance gate on a held-out set, not a cheap pre-filter.
- Smoke v0 (yolo11n, 20ep CPU, 1-class): val P0.79 / R0.25 / mAP50 0.39 on 3 held-out feeds — pipeline
  works, dome learnable; recall low as expected (real recipe = YOLO11s+P2, imgsz1280, more data, GPU).
- Heavy ML (torch/ultralytics, training) runs on a real GPU box, NOT this sandbox (slow/flaky net).
  cv2-only steps (collector, degrade, synthesis compositing) run fine locally.

## Plan

### Phase 0 — Recon & data plane  ✅ DONE
- [x] Verify Waymo-in-London + appearance; verify JamCam API; decode live clip (25fps/11s/277f)
- [x] Eyeball resolvability (near/mid dome ~5–15px, resolvable)
- [x] Collector `collector/data_plane.py`: list→conditional-GET clips→extract frames→SQLite.
      **Proven live: 12 cams, 637 frames.**

### Phase 1 — Design (dataset/training/inference)  ✅ DONE
- [x] Workflow `wod162893`: no ready dataset → bespoke; copy-paste engine; YOLO11s+P2; GPU runtime

### Phase 2 — Positive sourcing + copy-paste synthetic engine  ✅ DONE (39 domes, 400 positives)
- [x] Fetch CC Waymo imagery from Wikimedia Commons (28 imgs; 1 dome ref + many I-PACE negatives)
- [x] Copy-paste engine + JamCam degrade (`dataset/copy_paste.py`) — working
- [x] Synthetic generator (`dataset/make_synthetic.py`): cars→dome→labels. **80 positives proven.**
- [ ] Harvest more dome crops via yt-dlp/ffmpeg (YouTube/news) for angle variety
- [ ] Generate matched negatives (same cars, no paste); assemble dataset.yaml (waymo, wayve)
- [ ] Negative pool weighted to 5 hard-neg families (wayve bar, taxi sign, roof box, lightbar, moped)

### Phase 3 — Autolabel + verify
- [ ] YOLOE-11L visual-prompt proposer (localiser) + Claude vision dome/bar/neither (classifier)
- [ ] Self-hosted CVAT; import proposals as pre-annotations; human verify → labels in waymo.db

### Phase 4 — Train WaymoNet v0  ⏳ RECIPE READY (`train/`), awaiting rented-GPU run
- [ ] YOLO11s + P2 head, 2-class; rented 4090, imgsz=1280, domain augmentation
- [ ] Eval by held-out CLIP: P/R + AP@0.3/0.5, per-distance bins, waymo↔wayve confusion
- [ ] Ship-gate: precision≥0.9 + near-zero Wayve-as-Waymo; export ONNX

### Phase 5 — Inference runtime
- [ ] Always-on GPU; ONNX→TensorRT FP16@384; two-stage selective SAHI; ByteTrack collapse
- [ ] Redis/SQLite job queue (collector→worker); worker→Node :3104 sighting callback

### Phase 6 — Sighting feed (the product)
- [ ] Node API + cross-camera travel-time dedup; React+Vite+Leaflet map + confirm queue
- [ ] WhatsApp alerts (moltbot); "Powered by TfL Open Data"; FP-mining loop → retrain

### Phase 7 — Analytics
- [ ] "At least N" + Little's-Law concurrency (lower-bound captioned); hull/alpha-shape; KDE; 24×7

## Review

### 2026-06-09 (evening) — v0.4 autonomous coverage
User directive: no human-triggered capture — the site finds them. Shipped the continuous spine
loop: ~117 cams along Park Royal → A40 → Marylebone Rd → Euston Rd/KX, ETag conditional-GET per
cycle (decode only fresh clips), 24/7, per-camera WAL commits, cron demoted to supervisor
(flock + nice). ~2.3× clips/day, all on the fleet's corridor. ALERT_TH 0.88→0.93 (live tails beat
synthetic calibration; 6 FPs rejected+banked). Dataset audit (6 sheets emailed): dome templates
are street-level but JamCams look down — NEXT: harvest elevated-angle domes → re-seed centroid;
tighten synthetic host gate (vans/greys leak). Strategy locked: real positives first, train later.

### 2026-06-09 — Surfacer recall fix (v0.3)
4 days / 0 Waymos prompted a planted-positive recall test (`dataset/recall_eval.py`) instead of
more waiting. Found the live funnel was blind: 2.5% end-to-end recall, dome lift +0.016 (centroid
from close-up dome photos vs scoring on wide roof crops = domain mismatch). Fixed with tight roof
crop (22%/28%) + centroid re-seeded from synthetic roof crops at live geometry
(`collector/dome_centroid_tight.json`); camera-split AUC 0.614→0.839, recall 33–45%. Thresholds
recalibrated (PROB_TH 0.83, ALERT_TH 0.88 on the new scale). Deployed to VPS, 114 old-scale
pending candidates retired, sweeps verified. Next levers: burst mode on user sightings,
ETag polling for missed clip refreshes, edge camera. Lesson banked in `tasks/lessons.md`.
