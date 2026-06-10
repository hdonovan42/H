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

### Phases 3+4 — REAL-DATA ROADMAP (user-locked 2026-06-10; synthetic training retired)
1. **Find** — live 484-cam zone loop + ranked digests surface the first real Waymo(s) [RUNNING]
2. **Recalibrate** — `dataset/reseed_from_real.py` re-anchors scorer + thresholds on real
   crops; mine near archive ±45 min for extra passes → precision jumps, confirms accelerate
3. **Collect** — recalibrated loop runs until ~100+ confirms across ≥5 cameras (rejects
   accrue as vetted hard negatives for free); below that a detector memorises
4. **Train** — `dataset/build_real_dataset.py` (DB→YOLO dataset: confirms=labels,
   rejects=hard-neg backgrounds, by-camera split) → `train/preflight.py` (CPU, free) →
   `train/train.py` (YOLO26s-P2 @704, cache, auto-batch, mosaic 0.4) → `train/eval_gate.py`
   (IoU-matched recall vs vetted-neg FP on held-out cams; ship bar precision≥0.9) → ONNX
   [TOOLING BUILT + CPU-TESTED 2026-06-10; awaiting data]

### Phase 5 — Inference runtime
- [ ] Always-on GPU; ONNX→TensorRT FP16@384; two-stage selective SAHI; ByteTrack collapse
- [ ] Redis/SQLite job queue (collector→worker); worker→Node :3104 sighting callback

### Phase 6 — Sighting feed (the product)
- [ ] Node API + cross-camera travel-time dedup; React+Vite+Leaflet map + confirm queue
- [ ] WhatsApp alerts (moltbot); "Powered by TfL Open Data"; FP-mining loop → retrain

### Phase 7 — Analytics
- [ ] "At least N" + Little's-Law concurrency (lower-bound captioned); hull/alpha-shape; KDE; 24×7

## Plan — v0.5 reliable zone-wide coverage (2026-06-10)

Measured: 2.7s CPU/clip, 1 core pegged (85%), cycles 3-11 min vs 3-8 min refresh → ~80% spine
catch; 659 digest candidates/day (calibration drifted); zone = ~432 cams = 4× load. Build:

- [x] 1. OpenVINO INT8 yolo11n export (local, calib on 300 of our frames) + vid_stride 3→5
- [x] 2. Verified on VPS BEFORE building: 2.49s → 0.91s/clip (2.74×), INT8 finds MORE boxes
- [x] 3. live_capture v0.5: threaded poll (484 cams / 150s < min refresh) + tiered FIFO queues,
       spine never dropped, zone drop-oldest at 400 backlog; single process, single DB writer
- [x] 4. Telemetry: cycles table, timestamped lines, per-cam period EMA, digest coverage line
- [x] 5. run_watch.sh: stale-heartbeat watchdog (>10 min → kill hung loop, cron restarts)
- [x] 6. Recalibrated LIVE: PROB_TH 0.88, NEAR_TH 0.86, ALERT_TH 0.93 (>24h max FP 0.921);
       685 sub-bar pending demoted to near
- [x] 7. Component tests pass; recall_eval @0.88: 8%/pass synthetic (vs 54% @0.83) — frozen-
       embedding ceiling, offset by 4× opportunities + near-band mining; real positives fix it
- [x] 8. Deployed: rsync + openvino on VPS, old loop killed, cron restarting v0.5
- [x] 9. CHANGELOG v0.5 + commit + memory update

## Review

### 2026-06-10 (night) — v0.8.1 hourly candidate backup → github.com/hdonovan42/waymo
User-requested: all Phase-3 scored candidates preserved off-VPS (they were one prune-cycle
from deletion — 7-day retention). `backup_github.sh` (lives in the waymo repo itself, per
user; VPS cron :37) — append-only rsync of all candidate jpgs + candidates.csv/cameras.csv
snapshots into the repo clone, repo-scoped write deploy key (`github-waymo` alias). Pushed:
4,088 rows / 8,212 jpgs / ~217MB; idempotency + incremental commits verified. Watch repo
growth (~200MB/day) vs GitHub's soft ~5GB guidance; mitigation = drop crops or rotate repo.

### 2026-06-10 (evening) — v0.6 FIRST CONFIRMED REAL WAYMO 🎉
#2605, Limehouse Tunnel/Butcher Row, 15:26 London (white I-PACE, dark dome, user-confirmed).
Surfaced ONLY because of ranked sending (scored 0.868, under the old 0.88 bar) and zone-wide
coverage (east London). Phase 2 executed same-hour: confirm banked; centroid re-seeded
(50/50 real+synthetic — real re-scores 0.944 vs FP ceiling ~0.92); whole archive re-scored
from stored embeddings (313 promoted); thresholds re-anchored (PROB_TH 0.84 / NEAR_TH 0.80 /
ALERT_TH 0.92, new scale); ±45 min similarity-ranked mining sheet + top-200 recalibrated
retrospective of the full dataset emailed for review. Roadmap now in Phase 3 (collect).
Watch: alert FPs at 0.92 (archive tail 0.919), digest volume at 0.84, 24h live-tail recheck.

### 2026-06-10 (evening) — real-data training pipeline (Phase-4 tooling)
User locked the roadmap: find → recalibrate → collect clean → train YOLO for prod; all
synthetic training retired. Audit of old recipe found: yolo11s-p2.yaml doesn't exist (would
crash the GPU box), imgsz 1280 = 3× compute on interpolation, mosaic 1.0 pushes domes below
the resolvability floor, gate counted stray boxes as recall, no real-data path at all.
Shipped: build_real_dataset.py (waymo.db → dataset; confirms=labels, rejects=hard negs,
'near' never used as negatives — unreviewed), train.py on YOLO26s-P2 @704 (latest gen,
verified builds + COCO transfer), eval_gate.py (IoU-matched, real negatives incl. rejected
Wayves), preflight.py (CPU, catches all crashes free). Full chain tested with fabricated
confirms: build → split → preflight PASS. eval_wayve_gate.py (synthetic) deleted.

### 2026-06-10 (later) — v0.5.1 ranked budgeted sending
User: recall to their eyes is everything ("make sure they are sent to me"). Fixed thresholds
can't deliver that with an overlapping scorer, so sending flipped to score-RANKED within a
fixed daily review budget (DAY_CAP 1600 = 8 pages, sent flag per row, EOD overflow → archive,
alert-level survivors kept). Eligibility 0.86, archive floor 0.80 (predicted real-Waymo band
stored, re-cuttable). Tested on scratch DB (ranking, cap, reset, demotion). Deployed + loop
restarted. Aggregation maths: ~15-25%/view at the floating cut × many fleet views/day →
>90%/day that a real Waymo hits the sheets, if the synthetic proxy holds.

### 2026-06-10 — v0.5 reliable zone-wide coverage
User: coverage is existential for the site; first digest also drowning in cars. Measured first
(2.7s/clip torch, 1 core pegged, ~80% spine catch, 1,188 live FPs ≥0.81/24h, zone = 484 cams),
then shipped: OpenVINO INT8 (calibrated on our frames, 2.74× with stride 5, VPS-verified
BEFORE the rewrite), threaded 150s ETag poll of all 484 zone cams (< min refresh → polling
misses nothing), tiered queues (spine never dropped, zone drop-oldest counted), cycles
telemetry + digest coverage line + heartbeat watchdog for hangs, thresholds re-anchored to
live data (0.88/0.86/0.93). Honest trade-off recorded: synthetic recall 8%/pass at the new
bar — offset by 4× scoring opportunities; scorer quality is the REAL-positive flywheel's job.

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
