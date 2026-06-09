# Stage-2 dataset layout (white-Waymo vs white-non-Waymo classifier)

Binary classifier that runs *after* the Stage-1 white-car filter. Data lives under `data/stage2/`
(gitignored — images aren't committed; this file is the manifest/policy).

```
data/stage2/
  negatives/        TRAIN — white non-Waymo crops (vans, civilian I-PACEs, white cars, roof confusers)
  positives/        TRAIN — confirmed real Waymo crops   (currently 0; need ~30–40 to train)
  test/
    negatives/      HIDDEN TEST — held-out white non-Waymos. NEVER train on these.
    positives/      HIDDEN TEST — held-out confirmed Waymos (created when positives exist)
```

## Hard rule
**Never train on `test/`.** It is the held-out evaluation set — touching it at train time invalidates
every accuracy number. The build/train scripts must glob `negatives/` + `positives/` only.

## Current counts (2026-06-06)
- Train negatives: **229**
- Test negatives: **4** (held out deliberately — see below)
- Positives (train + test): **0** — Stage-2 training is blocked until real Waymos are confirmed.

## Held-out test negatives — deliberate "almost-Waymo" cases
Chosen because they are the *hardest* negatives: white crops that cleared the surfacer's 0.86 bar yet
are not Waymos. They measure the trained classifier's false-positive resistance on its worst cases.
- `hard_20_87.jpg`, `hard_21_87.jpg`, `hard_22_86.jpg` — clean white crossovers/SUVs (I-PACE silhouettes)
- `hard_18_86.jpg` — white roof-structure close-up (pure dome-vs-not confuser)

As more real positives arrive, hold out a matching slice of confirmed Waymos into `test/positives/`
(roughly the same train/test ratio) so the test set has both classes.
