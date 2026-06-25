# WaymoNet — GPU rental & training notes

Practical companion to `RUNBOOK.md` (RUNBOOK = the recipe/rationale; this = the step-by-step
how-to, the gotchas we actually hit, and the **Run 1 baseline numbers** to compare against).
First proven end-to-end on **Vast.ai, 2026-06-20**. Powered by TfL Open Data.

## RUN_2 — pre-rental checklist (2026-06-22)
Status: dataset built + **PREFLIGHT PASS** (154 boxes / 147 frames / 99 cameras + 229 hard negs ×10).
Locked: **fresh from COCO** (do NOT warm-start from RUN_1), **`--name waymonet_real_v2`**, attached 4090
full-rescore. Details below; this is the ordered run sheet.

### A. Off the clock (VPS + laptop) — BEFORE renting
- [ ] If new confirms landed since: `.venv/bin/python dataset/build_real_dataset.py && .venv/bin/python train/preflight.py` → "PREFLIGHT PASS"
- [ ] Train bundle: `cd ~/waymowatch && tar czf /tmp/waymonet_train.tgz train/ data/dataset_real/` → pull to laptop
- [ ] Rescore inputs: `tar czf /tmp/cand_frames.tgz -C data candidates` (~1.9 GB), THEN
      `.venv/bin/python eval/export_score_manifest.py --out /tmp/run2_manifest.csv` (manifest after the tar so every row has a frame) → pull both to laptop
- [ ] Vast: add credit; paste the **laptop** SSH pubkey at Account → SSH Keys
- [ ] **#5 — the two rescore-report fixes (recommended: DO #2, SKIP #1 — explained below). ~5 min.**

### B. On the clock (RTX 4090) — ~40–75 min total, ~$0.30–0.50
- [ ] Rent: RTX 4090 · PyTorch template · ~30 GB disk · On-Demand · reliability >99%; copy the **Direct SSH** line (the `>_`/key icon, NOT "OPEN")
- [ ] Upload + setup: `scp -P <port>` both tgz to `/workspace`; `tar xzf …`; `/venv/main/bin/pip install 'ultralytics==8.4.63'` (REUSE `/venv/main` — never a fresh venv)
- [ ] Train: `nohup /venv/main/bin/python /workspace/train/train.py --device 0 --name waymonet_real_v2 > /workspace/train.log 2>&1 &` (~30–70 min at this dataset size)
- [ ] **GATE (ship decision):** `/venv/main/bin/python /workspace/train/eval_gate.py --weights /workspace/data/runs/waymonet_real_v2/weights/best.pt` → recall @ precision-100% / 0 FP on held-out cameras; compare to RUN_1 (96.3% @0.10)
- [ ] Rescore (attached, ~3 min): `tar xzf cand_frames.tgz` → `/workspace/candidates`, then
      `/venv/main/bin/python /workspace/eval/rescore_all.py --weights /workspace/data/runs/waymonet_real_v2/weights/best.pt --frames-dir /workspace/candidates --manifest /workspace/run2_manifest.csv --out /workspace/run2_scored.csv --device 0`
- [ ] Pull back: `rsync -az -e "ssh -p <port>" root@<ip>:/workspace/data/runs/waymonet_real_v2/ ~/waymonet_run2/` + `run2_scored.csv`
- [ ] **DESTROY** the instance (trash icon — NOT Stop; Stop still bills storage)

### C. Post-rental (VPS)
- [ ] Report: `.venv/bin/python eval/run2_report.py --csv run2_scored.csv --email` → contradictions
      (rejects RUN_2 now calls Waymo = more hidden ones to recover) + RUN_1↔RUN_2 movement, stored in `model_scores`
- [ ] Deploy RUN_2 live: copy `best.pt` → **`collector/best.pt`** (VPS, in-process live scoring) AND
      **`~/waymonet-dash/best.pt`** (homebox, the dash); restart the loop (bracketed `pkill -f 'live_capture.py --[l]oop'`) + `waymonet-infer`; **recheck the dash canary threshold** — RUN_2 scores #40113 differently than 0.73
- [ ] Apply RUN_2 to the BACKLOG: the loop scores NEW candidates with RUN_2, but ~52k existing rows keep
      RUN_1 scores — reset `wn_scored=0` on `status IN ('new','near')` so the loop re-scores them with RUN_2 and surfaces anything RUN_1 missed (then the digest emails the new hits)
- [ ] Keep the **dome scorer** running through this eval (it still catches model misses)

### #5 explained — the two `run2_report` report-quality fixes
Both only tidy the post-train report (which finds MORE hidden Waymos); NEITHER affects the headline
output — "rejects RUN_2 now calls Waymo" works regardless. **Recommendation: do #2, skip #1.**
- **#2 — DO IT (~5 min, 1–2 lines).** The report flags `status='waymo' AND run2_conf < 0.05` as "a
  confirmed Waymo the model now scores ~0" — a *genuine recall miss* worth seeing. But the **5 edge
  positives** are deliberately low-conf / eval-only, so RUN_2 will score them <0.05 → ~5 false alarms
  that bury the real misses. Fix: export `special` in the manifest + exclude `special IS NOT NULL` from
  the miss check. Without it the miss-list is mostly noise.
- **#1 — SKIP.** The report uses `wn_conf` as the RUN_1 baseline for the RUN_1→RUN_2 *movement*; most
  **rejects** have `wn_conf=NULL` (rejected pre-WaymoNet; their RUN_1 scores live in `reject_scan.csv`,
  not the DB), so reject movement compares against ~0. Backfilling from the sweep CSVs would be
  **partial** (today's 230 new hard-negatives aren't in them) — a half-filled baseline is more
  misleading than an empty one — and the hidden-Waymo contradiction uses run2 alone, so it doesn't need
  it. Leave the reject baseline empty.
- **Third option:** skip both — the report still finds the hidden Waymos; you just read around ~5
  edge-positive false misses.

## Quick procedure (Vast.ai — proven)
1. **Build dataset** on the VPS: `.venv/bin/python dataset/build_real_dataset.py`
2. **Preflight** (free, CPU — never debug on the clock): `.venv/bin/python train/preflight.py` → "PREFLIGHT PASS"
3. **Stage a minimal bundle** off the clock (≈26 MB; avoids cloning the big monorepo):
   `cd ~/waymowatch && tar czf /tmp/waymonet_train.tgz train/ data/dataset_real/` → pull to laptop.
4. **Vast account**: add credit; paste your **laptop** SSH pubkey at Account → SSH Keys
   (`~/.ssh/id_ed25519.pub` — this is the key the agent/laptop connects with).
5. **Rent**: Search → `RTX 4090` → **PyTorch template** → disk **~30 GB** → **On-Demand** →
   reliability >99% → RENT.
6. **Get SSH**: Instances tab → wait for **running** → click the `>_`/key icon (NOT "OPEN",
   which is Jupyter) → copy the **Direct SSH** line `ssh -p <port> root@<ip>`.
7. **Upload**: `scp -P <port> ~/waymonet_train.tgz root@<ip>:/workspace/`
8. **Setup on box** (reuse the image's CUDA-torch venv — do NOT make a fresh venv):
   `cd /workspace && tar xzf waymonet_train.tgz && /venv/main/bin/pip install 'ultralytics==8.4.63'`
9. **Train** (~19 min on a 4090): `/venv/main/bin/python /workspace/train/train.py --device 0`
   (run under `nohup … > /workspace/train.log 2>&1 &` so an SSH drop can't kill it).
10. **Gate** (the ship decision): `/venv/main/bin/python /workspace/train/eval_gate.py
    --weights /workspace/data/runs/waymonet_real_v1/weights/best.pt`
11. **Pull back**: `rsync -az -e "ssh -p <port>" root@<ip>:/workspace/data/runs/waymonet_real_v1/ ~/waymonet_runN/`
12. **DESTROY** the instance (Instances → trash). ⚠️ NOT "Stop" — stopped instances still bill
    for storage; only Destroy ends all charges. (Optional full hands-off: install the `vastai`
    CLI + API key and `vastai destroy instance <id>`.)

## Gotchas we hit (and the fix)
- **`python` is not on PATH; torch lives in `/venv/main`.** On the Vast PyTorch image the
  CUDA torch is at `/venv/main/bin/python`, not system `python3` (which has *no* torch). Use
  `/venv/main/bin/{python,pip}`. **Never** `python -m venv .venv` — a fresh venv has no CUDA
  torch and pip then pulls a CPU build (silent slow training / errors). [→ RUNBOOK updated]
- **`dataset.yaml` baked an absolute build-box path** (`path: /home/hq/waymowatch/…`) → on the
  GPU box ultralytics crashed instantly: *"images not found, missing path /home/hq/…"*.
  **Fixed** in `train.py::portable_data_path()` — it repoints `path:` to the yaml's own dir at
  runtime (idempotent), so the dataset trains wherever it's rsync'd. No manual sed. [commit 0853333]
- **`cd /workspace && nohup … &` runs the `cd` inside the backgrounded subshell** → the
  foreground monitor was grep'ing the wrong directory. Use **absolute paths** for the nohup
  redirect *and* the script (`/venv/main/bin/python /workspace/train/train.py`); don't depend on cwd.
- **"OPEN" = Jupyter, not SSH.** The SSH line hides behind the `>_`/key icon or by expanding the
  card. The scary Jupyter-TLS-certificate dialog is irrelevant for us — we use SSH; skip it.
- **ONNX export auto-installs onnx/onnxruntime** on first run (~6 s, +7 packages). Harmless.
- **Prep off the clock.** Stage the bundle + preflight BEFORE renting; the GPU should only be
  alive for setup+train+eval (~30 min total here).

## Run 1 — baseline (2026-06-20, branch `waymowatch`, commit ~ddfdfe8 dataset)
**Dataset:** 100 Waymo boxes / 98 frames / **76 cameras** (2 multi-Waymo frames) + 588 vetted
negatives (hardest-first, 6:1 cap from a 7,488 pool). By-held-out-camera split:
train **71 pos + 426 neg**, val **27 pos + 162 neg** (19 held-out val cameras).
**Model:** YOLO26s-P2, 9.66 M params, 26.4 GFLOPs; COCO `yolo26s.pt` transfer (766/902 layers); imgsz **704**.
**Hardware/stack:** RTX 4090 24 GB · torch 2.12.0+cu126 · ultralytics 8.4.63 · AutoBatch = **9**
(13.1/23.6 GB, 56% VRAM); peak VRAM ≈ 13 GB; 32 vCPU / 440 GB RAM; 30 GB disk.
**Run:** **142/150 epochs** (early-stopped, patience 30) in **0.314 h ≈ 19 min** (~7.5 s/epoch;
~17 min train + val/export). cache=ram, mosaic 0.4→closed last 15.
**Metrics:** best per-epoch val **mAP50 0.986** (epoch 128); final-model val **mAP50 0.939**,
mAP50-95 **0.578**, P 0.948, R 0.815.
**ACCEPTANCE GATE (held-out cameras — the ship decision):**

| conf | recall | FP / 162 | precision |
|-----:|-------:|---------:|----------:|
| 0.10 | **96.3%** (26/27) | **0** | **100%** |
| 0.15–0.35 | 92.6% | 0 | 100% |
| 0.50 | 66.7% | 0 | 100% |
| 0.80 | 3.7% | 0 | 100% |

**GATE: PASS @ conf 0.10 — recall 96.3%, precision 100%, 0 false positives** on 162
human-vetted negatives (which include real rejected Wayves → dome-vs-bar discrimination tested
on real data). **Shipped the gate on the first real-data run.**
**Cost:** ≈ $0.15–0.25 (4090 ~$0.30/hr × ~0.5 h incl. setup) — confirm in Vast → Billing.
**Artifacts:** `~/waymonet_run1/` (best.pt 20 MB, best.onnx 37 MB @704, results.csv, curves,
confusion matrix).

## Run 2 — actual record (trained 2026-06-25, Vast.ai RTX 4090, `--name waymonet_real_v2`)
The decontaminate-via-RUN_1-rescore plan above was superseded: by the time we trained, the live
in-process scorer (v0.9.0) had already surfaced + the user had banked a much larger real set. RUN_2
trained on that. **Fresh from COCO** (NOT warm-started from RUN_1 — those weights learned the
recovered Waymos as negatives on the poisoned set).

**Dataset (built by `dataset/build_real_dataset.py`, `data/dataset_real`):**
- **Confirmed Waymos in DB:** 209 rows (`status='waymo'`), of which **5 edge_positive held out**
  (eval-only) → **204 training-eligible boxes across 190 frames** (12 multi-Waymo frames carry >1 box),
  spanning **112 positive cameras**.
- **Split is BY CAMERA** (whole feeds held out — the only honest split): 28 cameras → val.
  - **train: 143 positive frames + 4928 negatives** (= 5071 images)
  - **val: 47 positive frames + 300 negatives** (= 347 images)
- **Negative composition (train 4928):** 858 ordinary vetted rejects (hardest-first, **6:1 cap**) +
  **4070 hard-negative copies = 407 unique frames ×10**. Val negatives 300 = 282 ordinary + 18 hard (×1).
- **Pools available:** 190 confirm frames · **7428** ordinary rejects (capped to 6:1) · **425 curated
  hard negatives** (the model's OWN false positives, `data/hard_negatives/`) → train ×10 = 4070, val ×1 = 18.
- ⚠️ **The ×10 is PHYSICAL duplication** → 80% of every train epoch is 407 uniques re-augmented. Main
  speed/efficiency target for future runs (see "Bench / optimisation" below).

**vs RUN_1 (100 boxes / 98 frames / 76 cameras; train 71+426, val 27+162, 19 val cams, no hard-neg set):**
- Positives ~2× (204 vs 100 boxes; +36 cameras → far stronger by-camera val).
- Negatives: RUN_1 had **no** hard-negative ×10 set; RUN_2 adds 425 model-FP hard negs ×10 — this is
  the key recipe change to test at the gate (heavier negative emphasis → precision↑ but watch recall).

**Model / config (resolved):** YOLO26s-P2, **9,663,464 params, 26.4 GFLOPs**; COCO `yolo26s.pt`
transfer **766/902**; imgsz **704**; epochs **150** (patience 30, close_mosaic 15); **AutoBatch = 9**
(13.13/23.65 G, **56% VRAM**); optimizer auto → **MuSGD(lr=0.01, mom=0.9)**; cache=ram; mosaic 0.4,
scale 0.15, degrees 3, shear 2; **8 dataloader workers**.

**Hardware/stack:** RTX 4090 24 G (driver 535.113.01) · **32 vCPU / 503 G RAM** · torch 2.12.0+cu126 ·
ultralytics 8.4.63 · 30 G disk (4.4 G used). Direct-SSH; VPS→GPU key authorised for direct dataset push.

**Throughput observed:** **~64 s/epoch** steady-state (~10 it/s, 564 iters/epoch), peak VRAM ~6 G,
**GPU only ~58% utilised (dataloader-bound** — 8 workers on 32 cores can't feed the card; regular dips
to ~25%). Full 150 epochs ≈ ~2.7 h. (RUN_1 was ~7.5 s/epoch — RUN_2 is 10× the train images from the
×10 hard-neg blow-up, not a per-image slowdown.)

**Training:** ran to **epoch 127/150** (early-stopped on fitness, patience 30); best per-epoch val
**mAP50 0.972 @ e111**, final-model val **mAP50 0.959 / mAP50-95 0.529**. close_mosaic never triggered
(early stop landed before the last-15-epoch window). Curve: 0.58 (e19) → 0.87 (e43) → 0.93 (e62) → 0.97 (e111).

**GATE (ship decision — held-out cameras): PASS, and beats RUN_1**, on a BIGGER/HARDER val (47 pos /
300 neg / 28 cams vs RUN_1's 27 / 162 / 19):

| conf | RUN_2 recall | FP/300 | RUN_1 (ref) |
|---|---|---|---|
| 0.10 | **100%** | 0 | 96.3% @ 0/162 |
| 0.20 | **100%** | 0 | — |
| 0.25 | 97.9% | 0 | — |
| 0.30 | 89.4% | 0 | — |

100% recall to conf 0.20, 0 FP on 2× the negatives. Held-out → clean generalisation.

**Head-to-head vs RUN_1 — fresh rescore of all 43,370 candidate frames with BOTH weights (`eval/headtohead.py`):**
RUN_2 wins every metric. Confirmed-Waymo score (n=204): **mean 0.51→0.59, std 0.20→0.17 (tighter), min
0.00→0.10** (RUN_1 had a zero-scored Waymo; RUN_2's worst clears the 0.1 floor). Catch/leak (7905 rejects):
@0.10 **96.6%/88 → 100%/5**; @0.20 91.7%/41 → 98.5%/1; @0.30 83.3%/16 → 94.1%/**0**. Held-out cut (unbiased):
RUN_2 **100% recall @0.1–0.2, 0 leaks** on 487 rejects.

**Separation (the operating reality):** the 5 leaks were reviewed → **all confirmed NOT Waymos** (genuine
hard confusers). So **non-Waymo ceiling = 0.22** (#6318) vs **lowest real Waymo = 0.10** (#216, a lone
outlier; next-lowest 0.18) → a thin **0.10–0.22 overlap band** (3 Waymos / 5 confusers); 201/204 Waymos sit
above every confuser. **vs RUN_1: worst confuser 0.64 sat above 140/204 Waymos** (lowest Waymo 0.00, a
miss; confusers ≥0.30: 16) → RUN_2 collapsed the overlap **69%→1.5%, confusers ≥0.30 16→0**.

**CAVEAT — production 2026-06-25:** that 0.22 ceiling is on *labelled* rejects only (the model effectively
knew them). A **NOVEL** confuser (**#40294, scored 0.67**) was auto-banked live and caught at review — so
there is NO clean low cut on unseen data, and the **auto-bank threshold was raised 0.30 → 0.75** (near-
certain only; below → manual review). RUN_3: prise the band apart — #216 (the 0.10 Waymo) AND the
novel-confuser tail (#40294 @0.67 / #47783 @0.35, both now hard negatives) so the auto-bank cut can drop.

**Cost / wall-clock:** ~2.3 h training (127 epochs @ ~64 s) + ~4 h total instance lifetime incl. eval/debug;
4090 @ ~$0.30–0.40/h ≈ **~$1.50**.

### Bench / optimisation (RUN_2 idle-GPU experiments)
Diagnosed bottleneck: **dataloader starvation** (GPU ~58%, 8 workers / 32 cores) + **80% redundant
hard-neg ×10 duplication**.
- **DONE — GPU rescore batching** (`eval/rescore_all.py`). The rescore was *broken on GPU*: a whole-list
  `predict()` collates all 43k frames into one tensor → 49 GiB OOM. Two-part fix: hand-chunk the list AND
  key the verdict off the input path (batched `res.path` comes back as `image{i}.jpg`, not the filename —
  silently wrote 0 scores until caught). Measured @704: **batch 1→92 fps, 32→230 fps (~2.5×, 3.2 GB)**;
  plateaus past 32 (compute-bound, not data-starved). chunk=32 is the new default. See "Two inference
  paths" under Inference/serving — the live CPU path stays per-frame and was NOT touched.
- **NOT RUN — train-throughput matrix** (workers/batch/`rect`/`compile`; hard-weight ×3/×5 + imgsz 512
  gate runs). The rescore debugging consumed the idle window. `train/bench.py` + the hardlinked
  `dataset_hw{1,3,5}` variants are built and ready. [RESULTS: PENDING — next rental]

## Run 3 — plan (STANDING recipe from here: warm-start + full dataset)
**Why RUN_2 was fresh-from-COCO but RUN_3 won't be.** RUN_2 trained **fresh from COCO** (`yolo26s.pt`,
766/902 transfer — confirmed in the train log; `train.py` defaults, NO `--model`/`--weights` override)
*specifically because* RUN_1's weights were fine-tuned on the **poisoned** negative set — they'd learned
the later-recovered Waymos *as* negatives, and warm-starting would carry that contamination forward.
That poisoned lineage is now broken: RUN_2 trained on a decontaminated set, so **its weights are clean**.

**So from RUN_3 onward — warm-start from the previous run + train on the FULL dataset:**
- **Warm-start:** `train.py --model ~/waymonet_runN/weights/best.pt --name waymonet_real_v3` (a `.pt`
  passed as `--model` fine-tunes directly — no separate COCO `--weights` transfer). Inherits the prior
  run's learned features → faster convergence, builds on prior knowledge.
- **Full dataset, always:** never train on just the new confirms. `dataset/build_real_dataset.py` already
  rebuilds from the WHOLE DB each run (every `status='waymo'` + every `status='reject'`/hard-neg), so the
  set only grows and cleans. Just rebuild + preflight before each rental.
- **Fresh-from-COCO is the EXCEPTION** — use it ONLY to break a poisoned lineage (as RUN_2 did), never by
  default.
- **RUN_3 targets:** the 0.10–0.22 overlap (esp. #216) AND the novel-confuser tail (#40294 @0.67, #47783
  @0.35 — both banked as hard negatives 2026-06-25) so the auto-bank cut can drop from 0.75 back down.

## Attached full rescore + RUN_1↔RUN_2 eval (RUN_2 onward)
Score EVERY candidate with the new weights on the rented GPU (minutes) instead of ~5-9 h on the
homebox, and diff it against RUN_1. Bolt onto the end of the train job (train → gate → rescore):
1. **VPS, before renting:** `.venv/bin/python eval/export_score_manifest.py --out /tmp/run2_manifest.csv`
   (one row per candidate-with-frame + its frozen RUN_1 `wn_conf`; ~32 k rows). Stage frames too:
   `tar czf /tmp/cand_frames.tgz -C data candidates` (~1.9 GB) — pull to the laptop with the train bundle.
2. **GPU box, after the gate:** untar frames to `/workspace/candidates`, upload the manifest, then
   `/venv/main/bin/python /workspace/eval/rescore_all.py --weights <run>/weights/best.pt
   --frames-dir /workspace/candidates --manifest /workspace/run2_manifest.csv
   --out /workspace/run2_scored.csv --device 0` (~2–5 min on a 4090; `stream=True`, bounded memory).
3. **VPS, report:** rsync `run2_scored.csv` home, then
   `.venv/bin/python eval/run2_report.py --csv run2_scored.csv --email`. This:
   - stores RUN_1 (frozen) + RUN_2 in a NEW `model_scores(run_tag, candidate_id, conf, bbox, …)` table
     in waymo.db (the live `wn_*` columns are untouched) — compare any two runs with a self-join;
   - prints/emails the **CONTRADICTIONS** — rejects the model now calls Waymo (**Waymos poisoning the
     negatives** — recover them) and confirmed Waymos it now scores ~0 (miss/mislabel) — plus the
     RUN_1→RUN_2 hit-rate movement per status.

**Timing:** the rescore adds only ~2–5 min to the rental. Whole job ≈ train (~30–70 min at this dataset
size — ~1.9 k train images, ×10 hard negatives) + gate (~1 min) + rescore (~3 min) ≈ **~40–75 min,
~$0.30–0.50**. The ~1.9 GB frame upload is the only real cost — do it off the clock.

## Don't over-read Run 1
- **Tiny val (27 positives):** 96.3% recall = 26/27 (a single miss moves it ~3.7 pts); 0/162 FP
  is encouraging but a small sample. Treat as a strong **smoke test**, not a precise estimate.
- **At the data floor:** 100 boxes / 76 cameras is the *minimum* target — the plan is to keep
  collecting and retrain on a larger, less-noisy set. Expect the numbers to firm up as val grows.
- **Methodology is sound:** the gate evaluates on **held-out cameras** (generalisation, not
  memorisation), and Wayve discrimination is tested for free via the real rejected-Wayve negatives.

## Improvements / options for next runs
- **Weaker/cheaper hardware is fine** — the dataset is tiny. A 3060/T4 (~$0.10/hr) finishes in
  ~1–2 h; Apple Silicon works (`--device mps --batch 16`), free. The 4090 is just fast/convenient.
  Low VRAM → drop `--imgsz` to 512 or set a small `--batch`.
- **Automate teardown** (optional): `vastai` CLI + API key → `vastai destroy instance <id>` so the
  whole loop (including stop-billing) can be hands-off.
- **Grow the val set** before trusting precision/recall to a decimal point.
- **Re-export ONNX at the serving resolution** once Phase-5 inference (TensorRT) settles on one —
  accuracy must be validated AT the serving size (current export is @704).

## Inference / serving cost (measured 2026-06-20 — see CHANGELOG v0.8.62, `eval/`)
Training is the cheap one-off; what matters for serving is **per-frame inference cost**, measured
when scoring 956 live candidates with `best.pt` via `eval/score_candidates.py`:
- **~0.18 s/frame** at imgsz 704 on a CPU (dev box: WSL2, torch 2.12+cpu, OMP_NUM_THREADS=4) —
  ~5.5 fps. The model is small (9.66 M params, 26.4 GFLOPs) and 352×288 frames are mostly padding
  at 704, so it's fast on CPU. No GPU needed for the candidate-rate workload.
- **Memory: ~0.6 GB RSS, flat — but ONLY if you score one frame per `predict()` call.** Passing a
  list to `predict()` does NOT stream; it hit **15.4 GB** and OOM-killed the box. Loop per-frame.
- **Two inference paths — do NOT conflate (2026-06-25):**
  - **Live / production = per-frame on CPU.** `live_capture.py::wn_safe` (VPS in-process) + the homebox
    dash infer server score ONE frame per `predict()` call (~0.6 GB RSS). The memory-stressed VPS/homebox
    MUST stay per-frame — a list source OOMs (15.4 GB, above). **This is the normal job; leave it alone.**
  - **Bulk rescore on a rented GPU = hand-chunked batches.** `eval/rescore_all.py --batch 32` chunks the
    frame list itself (each `model.predict(chunk)` = one real GPU batch) → **~2.5× the card** (measured
    92→230 fps @704, 3.2 GB VRAM; plateaus past 32 — compute-bound, not data-starved). A *whole-list*
    `predict()` OOMs on GPU too (ultralytics collates the entire list into ONE tensor — the bug we hit:
    tried to alloc 49 GiB). **Batching is GPU-rescore-ONLY; it does not — and must not — touch the live
    CPU path.** Same rule for any future on-GPU bulk scoring (eval, dataset re-labelling): chunk by hand.
- **Throughput vs the funnel:** ~20–30 white-car survivors/cycle × 0.18 s ≈ ~5 s/cycle — trivial
  compute, but the production VPS is memory-stressed (inference is kept off it; the homebox is the
  inference host, v0.8.60). OpenVINO INT8 is the ~3× lever if a host ever needs it (re-validate the
  gate at INT8 — quantisation can shift the operating conf).
- **Operating conf is LOW:** real Waymos score ≈0.1–0.45 model conf (gate: 96% recall @0.10, 3.7%
  @0.80). An auto-confirm/alert bar lives near 0.1–0.25, never 0.7.
