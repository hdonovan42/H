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
