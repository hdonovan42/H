# Task: RUN_3 pre-rental work (from GPU_RENT_NOTES "Run 3 — plan", locked 2026-07-02)

All CPU, off the clock. Goal: the eval upgrades + builder changes that must exist before the
next rental, plus RUN_2 baseline numbers under the FIXED metrics (the ship-gate reference).

## Plan
- [x] Recover RUN_2's val cameras (content-hash the 47 val images vs banked waymo frames on the
      VPS — dataset_real is the untouched Jun-25 build). Result: 47/47 matched, 28 cams.
- [x] `train/val_cams_run2.txt` — commit the frozen 28-camera val list.
- [x] `dataset/build_real_dataset.py`: read pinned val cams from the file (new cams → train;
      `Random(13)` fallback only if the file is absent, with a loud warning); per-provenance
      hard-neg weights `--hard-weight-run1` (default 3) / `--hard-weight-run2` (default 10);
      write `val_meta.csv` (name, camera, captured_at for val positives → night-cut recall).
- [x] `train/eval_gate.py`: load ALL GT boxes per frame (was first-box-only); count false
      detections on POSITIVE frames (was neg-images-only); box-level + image-level recall in the
      sweep table; night-cut recall from val_meta.csv; `--data` flag for bench variants.
- [x] `train/confuser_gate.py` (NEW): `--export` on the VPS builds `data/confuser_suite/`
      (galleries data/special/{funny,i-pac,roof-box,van_roof} = held-out; hard_negatives/run2 =
      trained-in-RUN_3, incl. the novel tail #40294/#47783; edge_positive = recall side) +
      manifest; score mode reports per-group max/mean + PASS/FAIL vs --bar 0.67.
- [x] Verify locally (torch-cpu venv, RUN_2 weights from ~/waymonet_run2): eval_gate on the
      new pinned val → RUN_2 baseline under fixed metrics; confuser suite with RUN_2 weights.
- [x] Test-build the new builder on the VPS to a TEMP out dir (dataset_real untouched):
      pinned split reproduced the exact 28 cams; provenance weighting applied. Temp dir deleted.
- [x] Deploy: rsync builder + eval_gate + confuser_gate + val_cams file to the VPS.
- [x] Record RUN_2 baselines in GPU_RENT_NOTES; CHANGELOG; commit + push.

## Review
DONE + verified 2026-07-02. All tooling deployed to the VPS; RUN_2 build (dataset_real) preserved.
- **Val cams recovered exactly**: content-hash matched 47/47 val images → 28 cams → committed
  `train/val_cams_run2.txt`; the new builder's pinned split reproduces them verbatim.
- **RUN_2 baselines under the FIXED metrics** (74 pos frames/77 boxes/470 neg, test build @392
  boxes): box-recall 96.1% @0.10–0.20, FP-neg 3/470→0 @0.30, FP-pos 0/74, night 16/16 (100%) vs
  day 95.1%. Confuser suite: galleries max 0.000 (fully suppressed), run2_hardneg max 0.568 /
  mean 0.075, edge-positive max 0.636 — full table in GPU_RENT_NOTES.
- **Trigger status: 392/≈408 boxes, 106 run2 hard negs — compound trigger effectively MET.**
  Next: bank the outstanding review backlog, rebuild + preflight + suite export, rent.
