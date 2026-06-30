# Notes

*How to spot Waymos in London - using tfl JamCams.*

WaymoNet watches **TfL JamCam** traffic cameras and detects **Waymo**'s self-driving test cars - white Jaguar I-PACEs carrying a roof-mounted lidar **dome**, among other sensors . **Wayve** - coming next.

These notes cover two phases: **(1)** finding the first 100 confirmed Waymos by hand, and **(2)** the first model trained on that data.

## 0 to 100

Wanted JamCam-specific data — decided to collect my own.

<div class="pipe">
  <div class="stage stage-in"><div class="st-t">JamCams</div><div class="st-d">~600 cameras<br>polled every 150&nbsp;s</div></div>
  <div class="arrow">→</div>
  <div class="stage"><div class="st-t">Detect&nbsp;+&nbsp;track</div><div class="st-d">YOLO11n + ByteTrack<br>best frame per vehicle</div></div>
  <div class="arrow">→</div>
  <div class="stage stage-cull"><div class="st-t">White only</div><div class="st-d">cheap HSV gate —<br>culls the obvious non-Waymos first, before any heavy compute</div></div>
  <div class="arrow">→</div>
  <div class="stage"><div class="st-t">Roof score</div><div class="st-d">MobileNetV3 embedding<br>cosine vs “dome” centroid → rank</div></div>
  <div class="arrow">→</div>
  <div class="stage"><div class="st-t">Human</div><div class="st-d">top-ranked emailed<br>I confirm / reject</div></div>
  <div class="arrow">→</div>
  <div class="stage stage-out"><div class="st-t">Confirmed</div><div class="st-d">100 Waymos · 76 cameras<br>rejects → 7,488 hard negatives</div></div>
</div>

After the culling of obvious rejects, the surviving candidates are sent to me for manual review.

<p class="pipe-loop">↻ Every confirmation re-anchors the “dome” scorer on real roof crops, so the funnel sharpens as the data grows.</p>

Scorer's weak at 352×288, often confused by roof boxes and police sirens. Only needed to surface Waymos well enough for them to reach me — while banking confirmed negatives.

<figure class="wide"><img src="img/coverage_map.jpg" alt="Map of London: every watched camera in grey, every Waymo sighting in red"><figcaption>Where we look vs where we find. Grey = the 683 cameras watched; red = the 101 Waymos confirmed at 77 of them. A wide net, but the sightings cluster in central and west-central London.</figcaption></figure>

---

## First Model

With 100 real positives across 76 cameras, the data finally cleared the bar to train a proper detector.

**Recipe:** YOLO26s with a **P2 (stride-4) head** — the high-resolution feature map a 5–15 px dome needs — transfer-learned from COCO and trained at **704 px** on full-frame images plus the vetted negatives. Trained on a single RTX 4090.

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

## Second Model — RUN_2

Five days on, the live system — now scoring **in-process** with RUN_1 — had more than **doubled** the training set, and, just as importantly, **decontaminated** it: re-scoring the old data with RUN_1 caught Waymos that had been wrongly filed as negatives. RUN_2 trained on the cleaned, larger set.

**Dataset (vs RUN_1's 100 boxes / 76 cameras):** **204 Waymo boxes across 190 frames and 112 cameras**, plus **425 hard negatives** — the model's *own* false positives from RUN_1, the highest-signal negatives there are — oversampled ×10. Trained fresh from COCO (not warm-started from RUN_1, whose weights had learned the recovered Waymos *as* negatives) to 127 epochs on a single RTX 4090.

### The gate — better, on a harder test

Same ship test (recall vs false-positives on held-out cameras), now on a **bigger, harder** validation set — 47 positives / 300 negatives / 28 cameras, against RUN_1's 27 / 162 / 19:

| Confidence | Recall | False positives | Precision |
|---|---|---|---|
| **0.10** | **100 %** | **0 / 300** | **100 %** |
| **0.20** | **100 %** | **0 / 300** | **100 %** |
| 0.25 | 97.9 % | 0 / 300 | 100 % |
| 0.30 | 89.4 % | 0 / 300 | 100 % |

RUN_2 holds **100 % recall all the way to confidence 0.20 with zero false positives** — on twice as many vetted negatives.

### Head-to-head: RUN_1 vs RUN_2 on *identical* data

The honest comparison: score every one of ~43,000 candidate frames with *both* models and diff them. Across all 204 confirmed Waymos, RUN_2 is **more confident and more consistent**:

| | RUN_1 | RUN_2 |
|---|---|---|
| Mean score | 0.51 | **0.59** |
| Spread (std) | 0.20 | **0.17** — tighter |
| Lowest-scoring Waymo | **0.00** — a total miss | **0.10** — still above the alert line |

And at every threshold it **catches more Waymos while leaking fewer non-Waymos** (out of 7,905 vetted rejects):

| Confidence | RUN_1 — recall / leaks | RUN_2 — recall / leaks |
|---|---|---|
| 0.10 | 96.6 % / 88 | **100 % / 5** |
| 0.20 | 91.7 % / 41 | **98.5 % / 1** |
| 0.30 | 83.3 % / 16 | **94.1 % / 0** |

On the unbiased held-out cameras alone, RUN_2 reaches **100 % recall at 0.1–0.2 with zero leaks** — genuine generalisation, not memorisation.

**In the wild.** Live, the difference is obvious in the review inbox: RUN_2 surfaces **far fewer false positives** than RUN_1 did — real Waymos now arrive in clean batches with only a handful of confusers alongside, instead of the human wading through RUN_1's wider net. The day-to-day reviewer load dropped sharply, exactly as the 86-fewer-false-positives head-to-head predicted.

### The gap that matters — and the work that's left

Recall-at-a-threshold hides the real question: **how far apart are the two score distributions?** If the weakest real Waymo outscores the strongest confuser, one clean cut separates them. If not, there's an overlap band where no threshold is perfect. Scored across all 204 confirmed Waymos and all vetted non-Waymos:

| | RUN_1 | RUN_2 |
|---|---|---|
| Lowest-scoring **real Waymo** | **0.00** — a total miss | **0.10** |
| Highest-scoring **non-Waymo** | **0.64** | **0.22** |
| Real Waymos *below* the worst confuser | **140 / 204** (69 %) | **3 / 204** (1.5 %) |
| Confusers scoring ≥ 0.30 | 16 | **0** |

RUN_1's distributions overlapped badly — a single confuser at **0.64** outscored *140 of 204* real Waymos, so no threshold could cleanly separate them (the held-out gate only looked clean because those particular confusers weren't in its small val split). RUN_2 collapses that band: confusers now top out at **0.22**, and **201 of 204** Waymos sit above every one of them.

**Still some work to do.** That leaves a thin overlap from **0.10–0.22**: three real Waymos dip into it (the lowest, 0.10, is a lone outlier — the next is 0.18) against five stubborn confusers (a 0.22 worst case, manually reviewed and confirmed *not* Waymos). A cut near 0.22 separates 201/204 Waymos from every confuser but drops those three; a low cut near 0.10 catches everything at the cost of a few false alarms — which, with a human in the loop, is the trade we want. RUN_3's job is to prise that band further apart.

One honest caveat the table hides: those non-Waymos are the ones we'd *already reviewed and filed as rejects* — confusers the pipeline had caught. They're a curated sample, not a fair slice of London traffic. The hardest confusers are, almost by definition, the ones still sitting *unlabelled* in the backlog — and once deployed, one of those scored **0.67**, right in the middle of the real-Waymo range. So that clean separation is measured on the confusers we knew about; making it hold on the ones we don't is exactly what more data, and the next model, are for.

---

*Powered by TfL Open Data. WaymoNet is an independent research project, not affiliated with Waymo, Wayve, or Transport for London.*
