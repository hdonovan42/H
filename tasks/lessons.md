# Lessons

## WaymoWatch

### bank_shown.py banks the WHOLE accumulated cycle_shown.json — scope bulk-bank to what was reviewed (2026-06-15)
`confirm_cycle.py` appends every sheet's shown ids to `data/candidates/cycle_shown.json` and only
`bank_shown.py` clears it (on a "no waymos" verdict). If it isn't run for several cycles the file
accumulates ALL shown ids (865 across ~8 cycles in one case). So `bank_shown.py` rejects far more
than the latest sheet the user just gave a verdict on.

**Why this is dangerous:** the rejcheck safety net re-surfaces only the TOP-100 rejects BY SCORE.
Mid-scoring real Waymos (e.g. #23121 at 0.822, found via the cosine new-to-you sheet) would be
banked and then NEVER resurface — permanently buried. Confirmed reals are routinely mid-scoring.

**How to apply:**
- When the user gives a verdict on a specific sheet ("the top-200 retro had zero waymos"), bank
  EXACTLY that sheet, not the whole accumulated record. Reproduce the retro precisely as
  `id IN (cycle_shown) AND status NOT IN ('waymo','reject') ORDER BY score DESC LIMIT 200`
  (verify count + score range match the retro email before committing).
- Always `--confirm` any reals the user flagged BEFORE banking (bank skips status='waymo').
- Only use blanket `bank_shown.py` when the user has actually reviewed the full accumulated
  backlog, or explicitly says to clear everything.

### Special/gallery cases are EVAL-ONLY — never training data (user, 2026-06-15)
Gallery rows (the `special` column set: roof-box / i-pac / funny / van_roof) are reserved for
MANUAL POST-TRAIN EVALUATION and are excluded from the training set in BOTH directions. Enforced
by `build_real_dataset.py`: positives = `status='waymo'` only; negatives = `status='reject' AND
special IS NULL`. A gallery row therefore carries `status='reject'` but its `special` tag holds it
out of the negative pool. This has been the design since 2026-06-11 (memory v0.8.15).

**How to apply:**
- Treat eval-exclusion as the DEFAULT — it's established, not a per-filing decision; don't present
  it as a choice I'm making.
- Report training pools PRECISELY: training negatives = `reject AND special IS NULL`, NOT the raw
  reject count (which includes the eval-only specials — 37 as of 67 confirms).
- Filing a special = `status='reject'` + `special='<gallery>'` + copy crop+frame to
  `data/special/<gallery>/`. The DB `special` tag (not the folder) is what enforces exclusion;
  keep the folder in sync for the visual eval set, but a missing folder image never causes a leak.

### Surfacer false-positive pattern (2026-06-05)
The bootstrap surfacer (frozen MobileNetV3 embedding → cosine to the 39-dome centroid) at
`PROB_TH=0.83` produces mostly **shape-confusion false positives**, not real Waymos:
- **Round/bright objects** score dome-like — a cement-mixer barrel (#495, 0.86) topped the batch.
- **Dark cars with a bright roof highlight** slip the `is_white()` Stage-1 filter (#499, #515).
- Genuine white crossovers (Tesla Model Y, ordinary I-PACEs) sit at 0.83–0.87 too — there is **no
  margin** between them and a Waymo at this resolution with a frozen embedding.

**Root cause:** only 39 dome templates and a *frozen* (untrained) embedding → the centroid encodes
"white car-ish roof", not "lidar dome". CV is too noisy to separate dome-vs-no-dome cheaply.
**This is expected** and was called out pre-build — the surfacer is a *recall-biased bootstrap* to
collect real positives, not the detector.

**How to apply:**
- Don't chase the false positives by nudging `PROB_TH` — at this base rate (Waymos are rare) the bar
  can't be both high-recall and high-precision with a frozen embedding. Accept FPs; the human gate is
  the precision stage.
- Every cleared-but-rejected **white car** is a *hard negative* (it beat the surfacer) → bank it into
  `data/stage2/negatives/` with a `hard_` prefix. These are disproportionately valuable for Stage 2.
- The real fix is **Stage 2** (a trained white-Waymo-vs-white-non-Waymo binary classifier) + retraining
  the surfacer on real CCTV dome crops — both blocked on getting the first ~30–40 confirmed positives.
- Batch 1 (7 high-prob, all-time): **0 Waymos**, 4 banked as hard negatives → negatives pool 221→225.

### White-filter tightening — colour ≠ separable from grey/green (2026-06-05)
After the VPS watch turned into an hourly firehose of FPs, measured what `is_white` can actually do.
Grid-searched thresholds against 3 real colour leaks (red/grey/green) + the 225 white crops:
- **Saturation is the only clean discriminator.** A mean-saturation gate `s.mean() < 0.24` rejects
  bright-coloured cars (red leak mean-sat 0.256) at ~2% white-recall cost (98%→96–97% pass).
- **Grey/silver (mean-sat 0.07) and muted dark-green (0.135) are AS desaturated as white** — they
  cannot be separated from white by colour at 352×288. Only the dome classifier can. Don't try to
  tighten further to catch them: every threshold that rejected grey also rejected 25–40% of real
  white crops (i.e. would drop real white Waymos too).
- **Brightness/fraction tightening hurts recall fast** — the 225 whites include dingy/shadowed cars;
  raising `v>` / fraction thresholds nukes them.
**How to apply:** Stage-1 colour filter is a coarse pre-filter only. Accept that grey/silver/muted
vehicles pass; that's the classifier's job, not HSV's. Validate any filter change against the 225
white crops (must stay ≥~95% pass) before deploying.

### Alert design under a high-FP bootstrap (2026-06-05)
Count-triggered digests (every N) + a loose surfacer = hourly all-FP spam. Switched to **one daily
digest** at 20:00 London (`maybe_send_daily_digest`, code-gated, TZ-correct) and raised `PROB_TH`
0.83→0.86 (~halves volume). **Risk logged:** with 0 real positives we can't calibrate the bar — a
low-res CCTV dome may score <0.86 and be missed. Re-examine the bar the moment a real positive lands.

### Never run a detector in production without a planted-positive recall test (2026-06-09)
WaymoWatch's surfacer ran live for 4 days, 153 candidates reviewed, 0 Waymos — and the whole time
its end-to-end recall on realistic planted positives was **2.5%** (dome lift on the score: +0.016).
The system *looked* healthy (sweeps ran, digests sent, scores clustered near the bar) while being
functionally blind. Zero detections carried no information because P(surface | Waymo in frame) ≈ 0.
The bug wasn't a crash — it was a silent domain mismatch: centroid from close-up dome *photos*,
scoring on wide in-frame roof crops; the embedding never saw the dome.
**How to apply:**
- Before trusting any "no detections yet" result, **measure recall end-to-end with planted
  positives through the exact production code path** (same functions, same thresholds) — not a
  proxy eval on crops. WaymoWatch's crop-level separability evals all passed while the funnel was blind.
- A paired test (same input with/without the target feature) directly measures whether the score
  even sees the discriminating feature. If the paired lift ≈ 0, no threshold tuning can help.
- Embedding similarity is domain-fragile: templates and queries must come from the SAME crop
  geometry/scale/codec. Share the crop function (one source of truth) between seeding and serving.
- Days of silence from a rare-event detector are NOT evidence it's working. Only a recall number is.

## 2026-06-10 — Don't screen data on heuristics when you can fix the label source (WaymoWatch)
Built a similarity-quarantine that excluded high-similarity implicit negatives from training
to prevent a missed Waymo poisoning the negative set. User correctly rejected it: the most
Waymo-like non-Waymos are the HIGHEST-value negatives, and the screen routed exactly those
around training — plus added threshold/embedding machinery to the builder.
**Pattern**: when a data-quality risk comes from weak labels, don't bolt a filter onto the
weak channel — delete the weak channel and use only strong labels (human verdicts), then
grow the strong channel operationally. Label-by-construction beats screening-by-heuristic:
simpler code, no magic thresholds, and the "dangerous" data flows INTO training once a
human resolves it (where it's most valuable) instead of being silently dropped.

## 2026-06-10 — Bulk verdicts are provisional, not gold (WaymoWatch #738)
A real Waymo was bulk-banked into the reject pool when the user declared a 200-cell sheet
clean — they later re-reviewed and found it (#738, 0.875). One missed cell in 200 ≈ expected
human error rate; the per-vehicle confirm (#) is gold, the bulk "sheet is clean" is ~99% gold.
**Pattern**: distinguish label provenance. Bulk-derived labels get a standing re-check —
re-rank and re-surface the top of the reject pool after every scorer recalibration (cheap:
one extra contact sheet per re-seed). The fix is process (re-show), not automated screening
(which the user rejected for routing hard negatives around training).
