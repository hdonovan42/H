# eval/ — run WaymoNet against live candidates, locally

Score real JamCam candidates with the **trained** detector (`best.pt`) on this machine,
without touching the live capture loop. Use it to see how the model judges a batch of
candidates the funnel surfaced — how many it calls Waymo, which ids, at what confidence.

Read-only on the VPS: it queries the DB with `mode=ro` and `rsync`s the candidates' full
frames down once (missing files only). All inference is local. Powered by TfL Open Data.

## Quick start

```bash
cd projects/waymowatch
source .venv/bin/activate            # ultralytics 8.4.63 + torch (cpu)

# Default scope = the "since 13:58" batch: 800 most-recent emailed `new` rows + all unsent `new`
python eval/score_candidates.py

# One candidate, or a set
python eval/score_candidates.py --ids 39921,39922,39923

# Everything captured after a UTC instant
python eval/score_candidates.py --captured-after 2026-06-20T13:00:00Z

# Re-score the cached frames (skip rsync); add an annotated contact sheet of the hits
python eval/score_candidates.py --no-fetch --sheet
```

## What it reports

- **WAYMO verdict per candidate** — a model detection that IoU-matches (≥0.30) the
  candidate's own stored host bbox at conf ≥ `--conf` (default **0.10**, the Run-1 gate's
  operating point: 96.3 % recall / 100 % precision / 0 FP). Same matching rule as
  `train/eval_gate.py`.
- **Model confidence** (`model_conf`) alongside the funnel's **dome score** for context.
- **Extra Waymo finds** — detections elsewhere in a frame that match no candidate bbox
  (a Waymo the funnel's box may have missed — worth eyeballing).
- **Conf sweep** of how many candidates clear each threshold.
- A **CSV** in `eval/out/` and, with `--sheet`, an annotated grid of the flagged frames.

## Key flags

| flag | meaning |
|------|---------|
| `--ids 1,2,3` | score exactly these candidate ids (any status) |
| `--n-sent N` | most-recent emailed `new` rows to include (default 800) |
| `--no-unsent` | drop the still-unsent `new` pool from the default scope |
| `--captured-after TS` | restrict to `captured_at >= TS` (UTC) |
| `--include-near` | also score `status='near'` (sub-bar silent archive) |
| `--conf C` | report threshold (default 0.10) |
| `--weights PATH` | model (default `~/waymonet_run1/weights/best.pt`) |
| `--no-fetch` | reuse already-downloaded frames |
| `--sheet` | write an annotated contact sheet of the hits |

## Compute cost (measured 2026-06-20, dev box: WSL2 16 GB, torch 2.12 cpu, OMP_NUM_THREADS=4)

- **~0.18 s/frame** on CPU at imgsz 704 (956 frames in 175 s). Run 1 model = YOLO26s-P2, 9.66 M
  params, 26.4 GFLOPs.
- **~0.6 GB RSS, flat** — *because* it scores one frame per `predict()` call.
- ⚠️ **Never `model.predict(list_of_paths)`** for a batch: it does NOT stream, ballooned to
  **15.4 GB RSS** and OOM-killed the machine (took WSL + the agent session down). This tool loops
  one frame at a time, `del`s each result, and raises its own `oom_score_adj`. If a run dies
  silently, check `dmesg | grep -i oom`.
- **Serving:** ~5 s/cycle for the live funnel's ~20–30 survivors — cheap, but the production VPS is
  memory-stressed, so a real auto-confirm worker runs on the **homebox** inference host, not the VPS.

## Notes

- Frames are scored at **imgsz 704** — the training resolution; don't change it without
  re-validating, accuracy is resolution-sensitive.
- The cache (`eval/_cache/`) mirrors the VPS frame paths and is gitignored, as is `eval/out/`.
- VPS host is the tailnet name `hq@vps-hel1` (public :22 is firewalled).
- The model runs on full 352×288 frames + bbox labels — never the review crops.
