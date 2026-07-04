# Notes

*How to spot Waymos in London - using TfL JamCams.*

WaymoNet watches **TfL JamCam** traffic cameras and detects **Waymo**'s self-driving test cars - white Jaguar I-PACEs carrying a roof-mounted lidar **dome**, among other sensors. **Wayve** - coming next.

Three generations so far: find the first 100 by hand, train on them, then let each model grow the dataset for the next. **RUN_3 is the model running live.**

## 0 to 100

No JamCam-specific dataset exists, so the first one had to be collected by hand:

<div class="pipe">
  <div class="stage stage-in"><div class="st-t">JamCams</div><div class="st-d">~600 cameras<br>polled every 150&nbsp;s</div></div>
  <div class="arrow">→</div>
  <div class="stage"><div class="st-t">Detect&nbsp;+&nbsp;track</div><div class="st-d">YOLO11n + ByteTrack<br>best frame per vehicle</div></div>
  <div class="arrow">→</div>
  <div class="stage stage-cull"><div class="st-t">White only</div><div class="st-d">cheap HSV gate —<br>culls the obvious non-Waymos first</div></div>
  <div class="arrow">→</div>
  <div class="stage"><div class="st-t">Roof score</div><div class="st-d">MobileNetV3 embedding<br>cosine vs “dome” centroid → rank</div></div>
  <div class="arrow">→</div>
  <div class="stage"><div class="st-t">Human</div><div class="st-d">top-ranked emailed<br>I confirm / reject</div></div>
  <div class="arrow">→</div>
  <div class="stage stage-out"><div class="st-t">Confirmed</div><div class="st-d">100 Waymos · 76 cameras<br>rejects → thousands of hard negatives</div></div>
</div>

<p class="pipe-loop">↻ Every confirmation re-anchors the “dome” scorer on real roof crops, so the funnel sharpens as the data grows.</p>

The scorer was weak at 352×288 — it only had to surface Waymos well enough to reach me, while every rejection banked a vetted negative for training.

<figure class="wide"><img src="img/coverage_map.jpg" alt="Map of London: every watched camera in grey, every Waymo sighting in red"><figcaption>Where we look vs where we find. Grey = the ~680 cameras watched; red = confirmed Waymos (first-100 era). Sightings cluster in central and west-central London. Map © OpenStreetMap · © CARTO · Powered by TfL Open Data.</figcaption></figure>

---

## RUN_1 — proof it works

100 positives / 76 cameras cleared the bar for a real detector: **YOLO26s with a P2 (stride-4) head** — the high-resolution feature map a 5–15&nbsp;px dome needs — trained at 704&nbsp;px on full frames plus the vetted negatives. One RTX&nbsp;4090, ~20 minutes.

<div class="figrow">
  <figure><img src="img/det_4.jpg" alt="Waymo detected at Wilton Road"><figcaption>Wilton Road · 0.64</figcaption></figure>
  <figure><img src="img/det_1.jpg" alt="Waymo detected, camera 1"><figcaption>held-out camera · 0.52</figcaption></figure>
  <figure><img src="img/det_3.jpg" alt="Waymo detected, camera 2"><figcaption>held-out camera · 0.55</figcaption></figure>
</div>

*The model drawing its own boxes on cameras it never trained on.* The ship test — recall vs false positives on held-out cameras — came back **96.3% recall, 0 false positives in 162 vetted negatives**.

---

## RUN_2 — cleaner data, cleaner scores

Doubled the data (204 boxes / 112 cameras) and **decontaminated** it — re-scoring the archive with RUN_1 recovered real Waymos wrongly filed as negatives. Added the highest-signal negatives there are: RUN_1's own false positives, oversampled ×10.

Result: **100% recall with zero false positives** on a doubled held-out test, and scored head-to-head over ~43,000 archive frames it beat RUN_1 at every threshold. One number tells the story: RUN_1's worst confuser (0.64) outscored 140 of 204 real Waymos; under RUN_2 the worst *labelled* confuser fell to 0.22, with 201/204 Waymos above it.

The catch, learned live: the hardest confusers are the ones **nobody has labelled yet** — a novel one scored 0.67 in production. Prising real Waymos further apart from those became RUN_3's job.

---

## RUN_3 — live

**498 confirmed Waymo boxes · 465 frames · 172 cameras**, plus 561 curated hard negatives (RUN_2's own live false positives weighted ×10). Two-stage: measured against RUN_2 on identical held-out cameras, then the ship model retrained on *everything* with a mosaic-off finishing pass.

On the held-out gate: **98.1% recall** (RUN_2: 97.1%), 1 false positive in 495 backgrounds, night recall 23/23. The worst labelled confuser: **0.568 → 0.080**.

### What a score means now

Every confirmed Waymo and every human-vetted non-Waymo (8,050 of them), scored by the live model. Pick a cut: **left column as high as possible, right column as low as possible.**

| Score cut | Waymos captured | Non-Waymos<br>wrongly captured<br>(of 8,050) |
|---|---|---|
| 0.9 | 2% | 0 |
| 0.8 | 56% | 0 |
| **0.7** | **76%** | **0** |
| 0.6 | 85% | 1 |
| 0.5 | 91% | 3 |
| 0.4 | 95% | 5 |
| 0.3 | 97% | 6 |
| 0.2 | 98% | 14 |
| 0.1 | 99% | 20 |

<figure style="max-width:600px;margin:12px auto 6px"><img src="img/confusers_row.jpg" alt="Three of the highest-scoring confirmed non-Waymos: white vehicles with roof-mounted clutter"><figcaption>Three of the highest-scoring confirmed non-Waymos — 0.55 · 0.54 · 0.49. (The actual top confuser, 0.64, is a white car glimpsed through a tree.)</figcaption></figure>

The adjudication pass is done — and it cut both ways: the model *disputed four of its own training labels*, "non-Waymos" from the earliest bulk reviews that turned out to be real Waymos, recovered into the positives. What remains above 0.5 is genuinely hard — pictured above: white vehicles carrying roof-mounted clutter. **The live cut is 0.70 — zero confirmed non-Waymos above it, ~76% of real Waymos banked hands-free.**

### Found in the archive

Rescoring the full ~43,000-frame archive with RUN_3 recovered **16 confirmed Waymos the previous model had scored ≈0.0** — captured by the cameras all along, but invisible below the review threshold, so no human ever saw them. Each generation re-reads the whole archive and finds what its predecessor missed (RUN_1 recovered mislabelled Waymos from the hand-collected era; RUN_2's rescore surfaced another; RUN_3 found sixteen — and caught its first two live Waymos within twelve minutes of deployment). It cuts the other way too: the new model *disputes* a handful of old "non-Waymo" labels from the earliest bulk reviews — those go back to a human for a second look.

### Hands-free banking

Anything the model scores above a set threshold becomes a confirmed sighting with no human in the loop (subject to an undo email). Since auto-banking began — **measured at a consistent 0.75 threshold throughout** — **16% of all new confirmed Waymos have arrived hands-free, with zero errors. 100% accuracy so far.** RUN_3's cleaner separation has allowed the threshold to be lowered to **0.70** (4 July): per the table, roughly **three-quarters of sightings should now bank themselves**, with a 0.06 safety margin above the worst confirmed confuser.

<div class="anet">
  <div class="a-io"><div class="a-t">608</div><div class="a-d">cameras</div></div>
  <div class="a-arrow">→</div>
  <div class="a-bar"><span class="a-lbl">Car filter</span></div>
  <div class="a-arrow">→</div>
  <div class="a-bar a-lo"><span class="a-lbl">White car filter</span></div>
  <div class="a-arrow">→</div>
  <div class="a-model"><div class="a-t">Model</div><div class="a-d">RUN_3</div></div>
  <div class="a-arrow">→</div>
  <div class="a-io a-out"><div class="a-t">Score</div><div class="a-d">0…1</div></div>
</div>

WaymoNet is an object **detector**: per frame it emits boxes with a confidence ∈ [0, 1], and the threshold above decides what counts as a sighting — everything below it still queues for human review, so recall is never silently lost.

---

*Powered by TfL Open Data. WaymoNet is an independent research project, not affiliated with Waymo, Wayve, or Transport for London.*
