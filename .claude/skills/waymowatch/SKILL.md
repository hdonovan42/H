---
name: waymowatch
description: Load full WaymoWatch project context — Waymo detection from TfL JamCams, live VPS loop, real-data training pipeline.
argument-hint: [task description]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, WebFetch, WebSearch
---

# WaymoWatch — spot & log Waymo test vehicles from TfL JamCams

Load context and begin working on WaymoWatch. If arguments are provided, carry out that task.
Otherwise run the **startup checks** below and ask what to work on.

## Startup checks (always do these first)

1. Read the durable memory: `~/.claude/projects/-home-hdonovan-hjd-ai-H/memory/waymowatch.md`
   (most detailed, most current — trust it over this file where they differ)
2. Read `projects/waymowatch/CHANGELOG.md` (top entry = latest shipped state) and the
   WaymoWatch sections of `tasks/todo.md` (roadmap + reviews)
3. Live status:
   ```bash
   ssh hq@89.167.4.126 "grep 'cycle:' /home/hq/waymowatch/data/candidates/capture.log | tail -5; \
     pgrep -f 'python collector/live_capture' >/dev/null && echo LOOP ALIVE || echo LOOP DEAD"
   ```
   Healthy = recent `cycle:` lines with `dropped 0` (or low) and LOOP ALIVE.
4. Confirms so far (the metric that matters):
   ```bash
   ssh hq@89.167.4.126 "cd waymowatch && .venv/bin/python -c \"import sqlite3; con=sqlite3.connect('data/waymo.db',timeout=60); print('confirmed waymos:', con.execute(\\\"SELECT COUNT(*) FROM candidates WHERE status='waymo'\\\").fetchone()[0])\""
   ```

## Project Overview

Detect Waymo's London test fleet (white Jaguar I-PACE, dark roof **DOME**) in TfL JamCam
video clips, autonomously, 24/7. Confirmed sightings become the real training set for
**WaymoNet**. Key confuser: **Wayve** also runs white I-PACEs — flat roof **BAR** vs dome
is the only low-res discriminator.

- **Repo path**: `projects/waymowatch/` (branch `waymowatch`; commit+push there)
- **VPS**: `89.167.4.126` user `hq`, path `/home/hq/waymowatch` (root@ if sudo needed)
- **Local venv**: `projects/waymowatch/.venv` (cv2, torch-cpu, ultralytics 8.4.63, openvino)
- **Alerts/digests**: Resend email → donovanh59@gmail.com (key in VPS `.env`, chmod 600)
- **`data/` is gitignored** both sides; the DB and jpgs live only on the VPS
- Attribution: "Powered by TfL Open Data". British spelling in user-facing text.

## The locked roadmap (user, 2026-06-10 — synthetic training RETIRED)

1. **Find** — live ~608-cam zone loop + ranked digests surface candidates [RUNNING]
2. **Recalibrate** — first confirm → `dataset/reseed_from_real.py` re-anchors scorer +
   thresholds on real crops; mine near archive ±45 min for more passes
3. **Collect** — recalibrated loop until **~100+ confirms across ≥5 cameras**
   (user rejections accrue as vetted hard negatives the whole time)
4. **Train** — `dataset/build_real_dataset.py` → `train/preflight.py` (CPU, free) →
   `train/train.py` (YOLO26s-P2 @704, rented 4090) → `train/eval_gate.py` (ship bar
   precision ≥0.9) → prod ONNX. Tooling built + CPU-tested; awaiting data.

Do NOT propose synthetic-dome work, Wayve sentinels, or extra signals — user has
explicitly rejected scope beyond this roadmap ("too far ahead").

## Live system (v0.5.1) — how it works

```
watch_loop (--loop, VPS, 24/7, single process):
  every 150s: threaded conditional-GET all ~608 cams (117 spine tier-1 + rest of zone tier-2, box east edge lon +0.06)
    150s < TfL min refresh (~180s) -> polling layer can never skip a published clip
  fresh clips -> tiered FIFO queues (spine first, never dropped; zone drops OLDEST >400)
  per clip: OpenVINO INT8 yolo11n det.track (ByteTrack, vid_stride 5, ~0.6s/clip)
    -> best view per track >=44px -> is_white -> tight roof_crop (top 22%, 28% inset)
    -> MobileNetV3 embed -> cosine vs dome_centroid_tight.json
  score >=0.86 -> 'new' (eligible) | >=0.80 -> 'near' (silent archive) | else discard
  SENDING IS RANKED, NOT THRESHOLDED: pages of 200 email the HIGHEST-scoring unsent,
    DAY_CAP 10000 cells/day; EOD demotes unsent overflow -> near (unsent >=ALERT_TH kept)
  instant alert >=0.93; daily digest 23:00 London with coverage line
  telemetry: cycles table + timestamped log; heartbeat file; run_watch.sh watchdog
    (cron */6 = supervisor: dead -> restart, hung >10min heartbeat -> kill)
```

User reviews emailed sheets, replies with `#` of any real Waymo →
`live_capture.py --confirm <ids>` banks to `data/real_positives/` (status='waymo').
Rejections (`--reject`) are kept forever and suppress that vehicle/spot permanently.

## Key files

| File | Purpose |
|------|---------|
| `collector/live_capture.py` | THE live system — loop, funnel, scoring, sending, retention |
| `collector/run_watch.sh` | cron supervisor + hung-loop watchdog |
| `collector/data_plane.py` | TfL API client, ETag http_get, SQLite helpers |
| `collector/dome_centroid_tight.json` | deployed scorer centroid (replace via reseed) |
| `collector/models/yolo11n_int8_openvino_model/` | committed INT8 detector (2.7x CPU) |
| `collector/email_alert.py` | Resend sender (recipient hard-locked) |
| `dataset/reseed_from_real.py` | Phase-2: confirms → new centroid + thresholds |
| `dataset/build_real_dataset.py` | Phase-4: waymo.db → YOLO dataset (real only) |
| `dataset/export_openvino.py` | INT8 export, calibrated on our frames |
| `dataset/recall_eval.py` | planted-positive regression harness (diagnostic only) |
| `train/preflight.py` → `train/train.py` → `train/eval_gate.py` | GPU run, in that order |
| `train/RUNBOOK.md` | full GPU procedure incl. pinned versions |

## Constants that matter (live_capture.py)

PROB_TH 0.83 (eligibility) · DAY_CAP 10000 · NEAR_TH 0.76 (archive floor) · ALERT_TH 0.91 ·
POLL_EVERY 150 · MAX_BACKLOG 400 · VID_STRIDE 5 · MIN_H 44 · DEDUP_TH 0.93 ·
ROOF_TOP/BOTTOM/INSET −0.06/0.22/0.28 (single source of truth — eval scripts import these)

## Operational gotchas (hard-won — do not relearn)

- **sqlite3 CLI absent on VPS** — query via `.venv/bin/python` + sqlite3 module; column is
  `captured_at` (not created_at); connect with `timeout=60`
- **pkill self-match**: `ssh host "pkill -f 'live_capture.py --loop'"` kills your own ssh.
  Use `pkill -f 'live_capture.py --[l]oop'` (bracket trick). Do NOT `rm` the lock file —
  run_watch.sh uses `flock`, which auto-releases on process death; removing it risks an
  inode race. The kill ssh often returns exit 255 as the session drops — verify separately.
- **RESTART ONLY ON A BAR CHANGE (user, 2026-06-13)**: restart the loop (bracket-pkill →
  cron supervisor restarts ≤6 min; don't start it manually) ONLY when PROB_TH/NEAR_TH/
  ALERT_TH actually change. Centroid-only reseed (bars held): rsync + commit the new
  centroid but DO NOT restart — the loop reloads it at the next bar-change restart. Each
  restart costs one ~70-100-clip catch-up burst (downtime backlog); a 1-real centroid shift
  moves live scores <0.001, and confirm_cycle re-scores the whole archive from the file
  regardless, so deferral is safe. (PROB_TH slides a notch every ~5 confirms, so a real
  restart still lands often enough to bound centroid drift.)
- Verify a restart by the proc's `etimes` (`ps -eo etimes,args | awk '/live_capture.py --loop/
  && !/awk/ && !/bash -c/'`), NOT the heartbeat — the heartbeat lingers ~160s after a clean
  exit, so a stale heartbeat reads as false-alive.
- Deploy code = `rsync -az collector/<files> hq@89.167.4.126:/home/hq/waymowatch/collector/`,
  then bracket-pkill ONLY if a bar/threshold changed. Never hand-edit code on the VPS.
- First poll after a restart = a one-time heavy catch-up cycle (clips published during the
  downtime), expect `dropped` >0 for ~1 cycle, then back to `dropped 0`.
- First poll after ETag wipe = ~480-clip burst (no etags) — expect 1-2 heavy cycles + drops
- Score scales are NOT comparable across centroid re-seeds — recalibrate thresholds from
  the LIVE distribution every time (synthetic calibration underestimates live FP tails)
- `yolo11s-p2.yaml` does not exist in ultralytics; `yolo26s-p2.yaml` builds + takes
  yolo26s.pt transfer. Pin `ultralytics==8.4.63` on GPU boxes.
- Local venv path issues after session breaks: `cd /home/hdonovan/hjd.ai/H/projects/waymowatch` first

## When the first confirm lands (Phase 2 — execute immediately)

```bash
# on VPS: bank the confirm if not already done
.venv/bin/python collector/live_capture.py --confirm <ids>
# mine the near archive ±45 min around the sighting for the same vehicle elsewhere
# then re-seed (local), rsync artifact, restart loop:
.venv/bin/python dataset/reseed_from_real.py     # prints new thresholds + deploy steps
```
Then re-anchor PROB_TH/NEAR_TH/ALERT_TH from the live score distribution at the new scale.

## Branch workflow (user-established 2026-06-10)

WaymoWatch work happens on the `waymowatch` branch; the dashboard session works directly on
`main`. **Since 2026-06-11 the public site lives at https://waymonet.com** (VPS nginx, NOT
GitHub Pages): source = `projects/waymowatch/site/`, deploy =
`rsync -az projects/waymowatch/site/ root@89.167.4.126:/var/www/waymonet/` — dashboard
changes no longer need a merge to main to publish. The old
`projects/waymowatch/index.html` is a redirect stub to waymonet.com (that one IS
GitHub-Pages-served, as is projects/projects.html, link text "WaymoNet").
The full cycle — never skip step 3:
1. Commit + push work to `waymowatch`.
2. When the user agrees: `git checkout main && git pull --ff-only && git merge --no-ff
   waymowatch && git push` (pull first — the dashboard session pushes to main directly).
3. **Immediately merge main BACK into waymowatch** (`git checkout waymowatch && git merge
   origin/main && git push`) so the branches never drift. This also pulls the dashboard
   session's main-only commits into waymowatch. Verify with
   `git log waymowatch..origin/main --oneline` → must be empty.

**API contract rule**: the dashboard (separate session; site source in
`projects/waymowatch/site/`, served at https://waymonet.com same-origin) consumes
`server/sightings_api.py` — `/api/sightings` fields (id, camera_id, captured_at, score,
common_name, view, lat, lon) and `/img/<id>[_frame].jpg`. NEVER change or remove existing
fields/routes without flagging it to the user first (the dashboard session must adapt in
step). Adding new fields is safe (additive); renames/removals/semantic changes are breaking.

## Standing user directives

- Fully autonomous detection — the site finds them; no human-triggered capture
- No API costs (no VLM gating); one-off GPU rental ~$1 is fine
- Real data only for training; "make sure they are sent to me" — recall to human eyes
  beats precision; the ranked DAY_CAP digest embodies this
- **Confirm-echo (2026-06-11)**: every confirm-cycle email leads with the confirmed
  vehicle's OWN crop+frame + an "if NOT a Waymo, reply 'undo #id'" line — id typos must
  never silently bank a non-Waymo into the positives
- **Consolidated cycle (v0.8.14)**: per confirm batch run `collector/confirm_cycle.py
  <ids>` on the VPS (after --confirm + centroid rsync) — ONE email (echoes + new-to-you
  sheet), retro every >=5 confirms or --force-retro after bar changes, rejcheck weekly.
  "No waymos" verdict -> `collector/bank_shown.py` (banks exactly the recorded shown ids)
- Auto-commit + CHANGELOG + push to `waymowatch` branch for any major revision
