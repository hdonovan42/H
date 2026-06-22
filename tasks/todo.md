# WaymoWatch — detection pipeline migration (in-process synchronous scoring)

**Goal:** WaymoNet as the PRIMARY detector, scored **synchronously in-process on the VPS**,
**frame-hash-bound**. Eliminate the lazy worker, homebox live-serving, the HTTP hop, the stale-frame
race, and the dome *gate*. (Approved 2026-06-22; recall audit: model ~96% capable vs 15% captured.)

## Increment 0 — prerequisites
- [x] Enable `earlyoom` on the VPS (root)
- [x] Put `best.pt` on the VPS (`collector/best.pt`)
- [x] Map the injection point (`live_capture.ingest`)

## Increment 1 — in-process synchronous scoring + cutover  [DONE, shipped v0.9.0 / d492eef]
- [x] Load WaymoNet once in `live_capture` (lazy, CPU)
- [x] Score each candidate in-process at capture; write verdict + `frame_sha`/`wn_frame_sha` atomically
- [x] Schema: `frame_sha`, `wn_frame_sha` (+ wn_* audit cols)
- [x] Best-view update re-scores in-process (no stale 0)
- [x] Offline-test vs homebox (#45157 → 0.642) + deploy + verify live (frame_sha == wn_frame_sha)
- [x] Drain the 12k email backlog (digest emailed recovered Waymos incl. 0.78)
- [x] CUTOVER: retire lazy worker (cron removed + killed); keep `waymonet-infer` for the dash only
- [ ] **score-every-view take-max** (leak #2) — currently scores the funnel's area-best view, one frame/track

## Increment 2 — safety net + cleanup
- [ ] `frame_sha`/`model_ver` periodic re-score sweep (IN-PROCESS on the VPS; replaces the worker's
      straggler role for rare in-process failures + enables targeted re-score on a new model). Retire scan_rejects one-offs.
- [ ] Demote dome to ranking-only / retire the legacy dome digest — **AFTER RUN_2 eval** (still catches
      model misses, e.g. #45157)
- [ ] CHANGELOG [x v0.9.0] + memory [x] updates

## Notes
- `best.pt` → `collector/best.pt` on the VPS; loop RSS ~0.66 G, ~0.06 core; earlyoom ON
- Restart loop = bracketed `pkill -f 'live_capture.py --[l]oop'` (own ssh call) → `run_watch.sh` `*/6` respawns
- RUN_2: deploy its `best.pt` to `collector/best.pt` + restart loop; the sweep then re-scores by `model_ver`
