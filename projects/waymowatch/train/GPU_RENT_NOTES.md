# WaymoNet — GPU rental & training notes

Practical companion to `RUNBOOK.md` (RUNBOOK = the recipe/rationale; this = the step-by-step
how-to, the gotchas we actually hit, and the **Run 1 baseline numbers** to compare against).
First proven end-to-end on **Vast.ai, 2026-06-20**. Powered by TfL Open Data.

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

## Run 2 — (in progress, 2026-06-21)
RUN_1 was used to re-score the existing dataset and **decontaminate** it (the biggest win). Plan:
warm-start from RUN_1 `best.pt` and retrain on the entire cleaned, larger set.
**Dataset (vs Run 1: 100 boxes / 98 frames / 76 cameras):**
- **Positives: 132 Waymos / 129 frames / 91 cameras** (+32). Split of the gain:
  **x = 13 removed from the NEGATIVES** (were `reject`; RUN_1 scoring caught them — they were
  poisoning the negative set: the headline win), **y = 5 from the unreviewed backlog** (+19 more
  confirmed from post-baseline live collection, not cleanly attributable). Earliest positive 2026-06-10.
- **Negatives:** vetted reject pool (hardest-first) **minus the 13 recovered Waymos**, plus
  **hard_negatives = 133** — RUN_1's OWN false positives (cars it thought were Waymos but weren't;
  highest-signal) — **weighted ×10** (oversampled in the manifest).
- special/edge_positive (2) excluded from training (as Run 1).
**Model/stack:** unchanged (YOLO26s-P2 @704, ultralytics 8.4.63, 4090 ~19 min, ~$0.20).
**Start checkpoint:** FRESH from COCO `yolo26s.pt` — `train.py`'s default; do NOT pass RUN_1 `best.pt`
(those weights were fine-tuned on the *poisoned* set — they learned the 13 recovered Waymos as
negatives, which warm-starting would carry forward). Run with `--name waymonet_real_v2` so RUN_2 lands
in its own run dir and doesn't overwrite RUN_1.
**Gate:** same held-out-camera acceptance (recall @ 100% precision, 0 FP); compare to Run 1 (96.3% R).
**Status:** PENDING — open whether to collect to ~200 positives first (now 132 / 91 cameras).

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
- **Throughput vs the funnel:** ~20–30 white-car survivors/cycle × 0.18 s ≈ ~5 s/cycle — trivial
  compute, but the production VPS is memory-stressed (inference is kept off it; the homebox is the
  inference host, v0.8.60). OpenVINO INT8 is the ~3× lever if a host ever needs it (re-validate the
  gate at INT8 — quantisation can shift the operating conf).
- **Operating conf is LOW:** real Waymos score ≈0.1–0.45 model conf (gate: 96% recall @0.10, 3.7%
  @0.80). An auto-confirm/alert bar lives near 0.1–0.25, never 0.7.
