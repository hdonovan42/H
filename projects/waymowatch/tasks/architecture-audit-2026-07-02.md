# WaymoWatch architecture audit — 2026-07-02

Four parallel audits: serving path (`live_capture.py`), review/banking pipeline
(`waymonet_digest.py` et al.), live VPS telemetry (read-only), training/eval
(`build_real_dataset.py`, `train/`). Synthesis below; per-domain detail in the section notes.

## Verdict

1. **Serving efficiency: good in aggregate, with known leaks.** In-process scoring keeps up 100%
   (0 NULL `wn_conf`, 0 unscored rows in 7d), lazy singleton, frame-sha-bound. But WaymoNet runs
   torch FP32 full-frame @704 (~0.35 s), un-batched, on ONE view per track, and the loop still does
   dead work (`review_sheet()` every cycle with no consumer).
2. **Coverage: the binding constraint is uptime + 2 vCPU, not the camera box.** Cycles average
   159 s vs the 150 s target (negative headroom, load ~1.5/2 cores); ~9.5k clips dropped per 7d in
   ETag-burst spikes; and a **48.5 h silent outage (Jun 27–29)** dwarfs every tuning gain. The
   polling layer itself is sound (654 cams tracked, ~98% seen in 7d).
3. **Efficacy: the model is recall-saturated on its val set; the ceiling is novel confusers.**
   RUN_3's gating input is run2-era hard negatives (~73 banked, target 100–150), not more positives
   (323 confirms / 138 cams). The eval gate has real blind spots and the train mix over-weights
   solved RUN_1 confusers ×10.

## Corrections to recorded state (docs/memory are stale)

- **The dome cosine gate is GONE (v0.8.65)** — every white ≥44px vehicle is WaymoNet-scored;
  NEAR_TH only affects retention of model-negative rows. Skill/memory "NEAR_TH = irrecoverable cut"
  is obsolete. Real pre-model gates: `MIN_H=44` + `is_white`.
- **No 0.30–0.75 dead band** — digest ceiling and auto-bank floor share `AUTO_BANK_TH`
  (`waymonet_digest.py:37`), so the 0.30→0.75 raise moved both.
- The 5 unbanked ≥0.75 rows seen today are just pre-midnight-batch, not stuck.

## P0 — reliability / silent-loss (trivial effort, highest value)

1. **Supervise the loop properly.** The `*/6` cron + `flock -n` failed to restart through a stale
   lock → 48.5 h outage. Move the loop to a systemd unit (`Restart=always` + `WatchdogSec`) or make
   `run_watch.sh` detect stale-lock-no-heartbeat and force-clear. Also alarm on "no cycle row in N min".
2. **Scoring-health alarm.** A persistent `wn_safe` failure is a total silent blackout: rows get
   `wn_hit=0`, digest sends nothing, capture-health stays green, rows pruned at 7d
   (`live_capture.py:274-276`, retention `:508`). One cron query: alarm if recent captures are all
   `wn_hit=0` or any `wn_scored=0` streak. Also spare `wn_scored=0` rows from the 7-day prune.
3. **Auto-bank banks then emails, no retry** (`waymonet_digest.py:129→137`) — on a quota failure the
   undo email is lost while rows are already `status='waymo'`. Check send result; hold/retry.
   Same class: `check_loop_health` writes its throttle marker even when the alarm email failed (`:239`).
4. **DB lock contention: 5,916 `database is locked` errors** (cycle-close + camera-refresh writers).
   Set `busy_timeout` on every writer, retry cycle-close. Some telemetry rows are being lost.
5. **Stale-model dead band:** on every `best.pt` swap, rows scored ≥0.75 by the old model are
   excluded from BOTH auto-bank (model-ver gate) and digest (≥0.75 cut). Make backlog re-score +
   `threshold_report.py` recalibration a scripted deploy step for RUN_3.

## P1 — serving efficiency / recall (ordered)

6. **Delete the per-cycle `review_sheet()` call** (`live_capture.py:876`) — reads ≤72 jpgs + writes
   a grid every 150 s with no consumer since the email retirement. Verify the retired
   `waymonet_worker.py` cron truly absent (it is per current crontab — keep it that way or formalise
   as backstop).
7. **OpenVINO export of `best.pt`** (adapt `dataset/export_openvino.py`: best.pt / imgsz 704 / nc 1).
   FP32 first (~1.3–1.5×, zero risk), INT8 (~2×) gated on a recall check over held-out positives +
   the 300-neg calib set (P2 small-object head under INT8 must be validated).
8. **Close leak #2 — score ≥3 views/track take-max** ({max-area, max-dome, last}) and drop the
   dome-conditioned re-score guard (`s > m[1]+0.01`, `:451`) so a WaymoNet-better later view always
   re-scores. Do after #6/#7 free headroom; this attacks the largest recall gap
   (the 15%-captured vs 96%-capable audit class).
9. **MIN_H 44 → 20** (`:124`; backfill already uses 20) — admits distant Waymos to the P2 model.
   Costs per-candidate predicts on a saturated box: land after #6/#7, watch cycle secs, revert bar
   is cheap. Optional partial: loosen `is_white` (0.30→0.25 whiteish, 0.24→0.28 sat) for the ~4%
   white-Waymo colour-gate loss.
10. **Digest max-age flush** — with the 10:00/22:00 forces removed, a lone real Waymo can wait
    unbounded below `--min 10`. Add "flush if oldest pending > 12 h".
11. **Filter `special IS NULL` in `sightings_api.py`** (`:56`, `:97`) — eval-only `edge_positive`
    rows currently leak onto the public map.

## P2 — training / RUN_3 prep

12. **Build an automated confuser regression gate.** Curated galleries (roof-box/i-pac/funny/
    van_roof) + the novel tail (#40294 0.67, #47783) are wired into NO eval. Gate RUN_3 on:
    held-out recall ≥ RUN_2 AND confuser-suite max score < RUN_2's — otherwise the 0.75 auto-bank
    cut can't drop. Include a sampled sweep of the unlabelled new/near pool (the honest ceiling).
13. **Fix `eval_gate.py`:** reads only the FIRST GT box per frame (`:40` — multi-Waymo frames
    under-evaluated) and never counts FPs on positive frames (`:75,:77`). Pin val cameras across
    runs (currently `Random(13)` over a growing cam list → gates not run-comparable).
14. **Rebalance hard-negative weighting:** real train ratio is ~1:34 pos:neg (×10 hard-negs bypass
    the "6:1" cap), and RUN_1's already-solved confusers get the same ×10 as RUN_2's novel ones.
    Run the staged-but-never-run `bench.py` hw ablation; RUN_3 ≈ run2 ×10, run1 ×1–3. Also fixes
    the RUN_2 dataloader starvation (58% GPU util).
15. **Collection priority: run2 hard negatives (~73 → 100–150) over raw positives.** The 64
    unreviewed [0.30,0.75) rows in the DB are exactly this queue — reviewing them yields either
    missed Waymos or the hard negatives RUN_3 needs. RUN_3 = warm-start from RUN_2
    (`train.py --model best.pt`), full dataset, imgsz 704 / mosaic 0.4 held.

## Strategic horizon

Full-frame WaymoNet on every clip (killing funnel, MIN_H, is_white, and leak #2 wholesale) costs
~19 s/clip on the VPS CPU — infeasible there, and is the homebox/GPU endgame per `inferencePlan.md`.
Not needed to hit the current roadmap; revisit at RUN_3+ if recall audits still show funnel losses.

## Key live numbers (2026-07-02)

- 323 confirms (318 training-eligible) / 138 cameras; 29 auto-banked; RUN_2 volume ≈ 40× RUN_1-era.
- Cycles: avg 159.1 s / p95 161.5 (48 h), ~290-clip ceiling, 9,564 dropped/7d (burst-shaped).
- Host: 2 vCPU EPYC, 3.8 GB RAM (374 MB swap used), load ~1.5, disk 53%, loop RSS 497 MB @143% CPU.
- wn bands last 7d: 35,705 zero / 89 [0.03,0.30) / 134 [0.30,0.75) / 28 ≥0.75; 0 scoring failures.
- Camera refresh EMA: p50 422 s, p95 1055 s (poll layer sound; refresh cadence is TfL-bound).
