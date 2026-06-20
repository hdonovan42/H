# WaymoNet — build notes

*How a self-driving-car spotter was bootstrapped from London's traffic cameras — and what the first trained model can do.*

WaymoNet watches **TfL JamCam** traffic cameras and flags **Waymo**'s self-driving test cars: white Jaguar I-PACEs carrying a roof-mounted lidar **dome**. The catch — **Wayve**, another London AV company, runs near-identical white I-PACEs with a flat sensor **bar** instead of a dome. At 352×288 CIF resolution, dome-vs-bar is essentially the *only* feature separating them, so the whole system lives or dies on a few roof pixels.

These notes cover two phases: **(1)** finding the first 100 confirmed Waymos by hand, and **(2)** the first model trained on that data — *RUN_1*.

---

## Phase 1 — Finding the first 100 by hand

A detector needs labelled examples and none existed, so the first job was a **recall-biased bootstrap**: surface anything plausibly Waymo-like to a human who confirms or rejects. Precision is the human's job; the machine only has to *not miss*.

**The pipeline, every ~150 seconds, 24/7:**

1. **Poll** — conditional-GET every camera in a ~600-camera central-London zone. Polling faster than TfL republishes means no clip is ever skipped.
2. **Detect + track** — an INT8 **YOLO11n** detector (OpenVINO, ~0.6 s/clip on a 2-core box) with **ByteTrack** collapses each moving vehicle across the clip into one track and keeps its best — largest, clearest — frame.
3. **Filter to white** — an HSV gate drops obviously coloured vehicles. (Grey/silver pass through — colour can't separate them from white at this resolution; that's the model's job later.)
4. **Roof embedding** — crop the roof, embed it with a frozen **MobileNetV3**, and score **cosine similarity** against a "dome" reference centroid.
5. **Rank, don't threshold** — the highest-scoring candidates are emailed as contact sheets, capped at a daily review budget. A weak scorer plus a fixed threshold would either flood the inbox or silently bin real cars; ranking against a human budget maximises the chance a real Waymo reaches human eyes.
6. **Human confirms** — I review the sheets and reply with the IDs of any real Waymos. Confirmed → a training positive. Rejected → a *vetted hard negative* — these are gold: the look-alikes that actually fooled the scorer.
7. **Recalibrate** — each confirmation re-anchors the centroid on **real** dome crops (the bootstrap started on synthetic composites), and the archive is re-mined ±45 min for the same vehicle elsewhere. Precision climbs and confirmations accelerate.

**The honest part:** the bootstrap scorer is weak *by design*. A frozen embedding can't reliably tell a lidar dome from a roof box or a bright reflection — it was never meant to be the detector, just a funnel that puts a human in front of the right ~200 images a day.

**What Phase 1 produced:**

| Metric | Count |
|---|---|
| Confirmed Waymos | **100** |
| Distinct cameras | **76** |
| Vetted hard negatives | **7,488** |
| Held-out eval set | 45 curated confusers + edge cases |

Every confirmation is a human verdict on the full camera frame — detector-grade labels (frame + box), not weak heuristics.

---

## Phase 2 — RUN_1: the first trained model

With 100 real positives across 76 cameras, the data finally cleared the bar to train a proper detector.

**Recipe:** YOLO26s with a **P2 (stride-4) head** — the high-resolution feature map a 5–15 px dome needs — transfer-learned from COCO and trained at **704 px** on full-frame images plus the vetted negatives. About **19 minutes** on a single rented RTX 4090.

### It works

<div class="figrow">
  <figure><img src="img/det_4.jpg" alt="Waymo detected at Wilton Road"><figcaption>Wilton Road · 0.64</figcaption></figure>
  <figure><img src="img/det_1.jpg" alt="Waymo detected, camera 1"><figcaption>held-out camera · 0.52</figcaption></figure>
  <figure><img src="img/det_3.jpg" alt="Waymo detected, camera 2"><figcaption>held-out camera · 0.55</figcaption></figure>
</div>

*The model drawing its own boxes on frames from cameras it never trained on.*

### The numbers that matter

The ship decision isn't mAP — it's **recall versus false-positives on held-out cameras** (cameras absent from training), swept over the confidence threshold:

| Confidence | Recall | False positives | Precision |
|---|---|---|---|
| **0.10** | **96.3 %** | **0 / 162** | **100 %** |
| 0.15 – 0.35 | 92.6 % | 0 / 162 | 100 % |
| 0.50 | 66.7 % | 0 / 162 | 100 % |

**Zero false positives across 162 human-vetted negatives** — and those negatives include real rejected Wayves, so dome-vs-bar discrimination is tested on *real* data, not synthetic. A second pass over the curated hard-confuser galleries (non-Waymo I-PACEs, roof-box cars, vans): **0 / 52 fired**.

<div class="figrow">
  <figure><img src="img/val_predictions.jpg" alt="Validation predictions"><figcaption>Predictions on a held-out batch</figcaption></figure>
  <figure><img src="img/pr_curve.png" alt="Precision–recall curve"><figcaption>Precision–recall (val)</figcaption></figure>
  <figure><img src="img/confusion_matrix.png" alt="Confusion matrix"><figcaption>Confusion matrix</figcaption></figure>
</div>

<figure class="wide"><img src="img/training_curves.png" alt="Training curves"><figcaption>Training &amp; validation curves — 142 epochs (early-stopped)</figcaption></figure>

### How it's applied

WaymoNet is an object **detector**, not a yes/no classifier. Per frame it emits boxes, each with a confidence ∈ [0, 1], and a threshold decides what counts as a sighting. Real Waymos land around **0.5–0.74**; the hard negatives produce *nothing* — a clean gap that lets a low cut (0.10) catch 96 % of Waymos with zero false alarms.

### Don't over-read RUN_1

This is a strong **baseline**, not a finished model. The held-out positive set is small (27 frames), so a single miss shifts recall by ~4 points — read these as a confident smoke test, not a final grade. The plan is to keep collecting and retrain on a larger, more camera-diverse set. RUN_1 is the number to beat.

---

*Powered by TfL Open Data. WaymoNet is an independent research project, not affiliated with Waymo, Wayve, or Transport for London.*
