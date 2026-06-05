# Lessons

## WaymoWatch

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
