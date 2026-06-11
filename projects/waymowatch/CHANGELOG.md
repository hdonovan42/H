# WaymoWatch — Changelog

## v0.8.15 — Special cases held OUT of training (manual eval set) (2026-06-11, evening)

User: the curated specials become a held-out manual evaluation set for the trained model —
they must not appear in the training data.

- New `special TEXT` column on candidates (live_capture ensure_schema + VPS ALTER);
  all 12 filed gallery vehicles tagged: roof-box 7 (#2126 #4014 #4015 #5701 #8604 #9688
  #10169), i-pac 2 (#4034 #9947), funny 3 (#5543 #8858 #10239).
- `build_real_dataset.py` negatives query now requires `special IS NULL` — specials can
  never enter training; suppression behaviour unchanged (they stay status='reject', never
  resurface on sheets).
- Filing protocol from now on: copy images to data/special/<gallery>/ + status='reject'
  + special='<gallery>'.
- Training-negative pool after exclusion: 3,356.

## v0.8.14 — Email consolidation: one mail per confirm batch (2026-06-11, evening)

User: "after each sighting i get multiple emails that have returned nothing the last 5
sightings." Investigated channel yield across all 34 confirms: ranked pages ~82%;
retro/mining/rejcheck = 0 in the last ~10 cycles (measured: ~90% of recent mining-sheet
rows had ALREADY been sent on pages — 48/67/70 of the last three top-72s). Structural:
at 34 reals each confirm barely moves the centroid, and the 10k DAY_CAP means pages
already deliver everything eligible.

- **`collector/confirm_cycle.py`** (new, runs on VPS): the whole post-confirm flow in one
  command — re-score archive -> re-bucket -> ONE consolidated email (echo images of every
  confirm in the batch + a combined NEW-TO-YOU sheet: never-sent rows ±45 min of any
  confirm, max-cosine ranked, skipped if <6 rows) -> trigger-based retro (every >=5
  confirms or --force-retro after bar changes) -> rejects re-check (every >=7 days or
  --force-rejcheck). Warns if the floor real drops below PROB_TH.
- **`collector/bank_shown.py`** (new): every sheet's shown ids are recorded in
  data/candidates/cycle_shown.json; a "no waymos" verdict banks EXACTLY those ids —
  replaces the fragile reproduce-by-query + mtime-cutoff banking.
- Triggers seeded (retro@34, rejcheck@2026-06-11). Pages + instant alerts untouched.
- Effect: a 2-confirm reply now produces 1 email instead of 4; last 5 sightings would
  have been 5 emails instead of 16, with measured loss of nothing.

## v0.8.13 — Confirm 34 (#10213, 3rd A2 New Cross cam) + funny/ gallery (2026-06-11, evening)

**#10213** (00001.03672 A2 New Cross Rd/Avonley Rd, 16:28) — the THIRD distinct A2 New
Cross camera with a confirm; the A2/Old Kent Rd corridor now accounts for 7 of 34.
**34 confirms / 31 distinct cameras.**

- Specials filed (all also rejected): **roof-box** +#9688 (A20 Lee High Rd — first
  special from an east-extension cam) +#10169 (Angel) = 7 specimens; **i-pac** +#9947
  (Putney) = 2; **NEW `data/special/funny/`** gallery: #5543 (Lwr Clapton) + #10239
  (Grays Inn Rd).
- Standard cycle: 34-real centroid; archive re-scored (n=10,411: p80 0.847 / max 0.917;
  reals 0.817-0.916 — floor ROSE 0.815→0.817). Bars unchanged: PROB_TH 0.80 / NEAR_TH
  0.76 / ALERT_TH 0.93. 56 promoted / 94 demoted.
- 3 sheets emailed: echo-mining around #10213 (888 in window) + top-200 retro
  (0.903..0.845) + top-100 rejects re-check (0.917..0.888).

## v0.8.12 — Confirms 32-33 (#4948, #6131) (2026-06-11, late afternoon)

**#4948** (00001.07365 A501 W of Park Sq East, 15:02 — the Euston Rd spine, new cam) and
**#6131** (00001.03656 Old Kent Rd/St James Rd, 14:18 — a SECOND Old Kent Rd camera; that
corridor has now produced 4 confirms across 2 cams). **33 confirms / 30 distinct cameras.**

- Standard cycle: 33-real centroid; archive re-scored (n=9,848: p80 0.847 / max 0.918;
  reals 0.815-0.915, floor margin 0.015). Bars unchanged: PROB_TH 0.80 / NEAR_TH 0.76 /
  ALERT_TH 0.93 (FP max back under 0.92; holding 0.93 rather than flip-flopping).
  2 promoted / 271 demoted.
- 4 sheets emailed: echo-mining around each confirm (1,052 + 1,037 in window) + top-200
  retro (0.912..0.847) + top-100 rejects re-check (0.918..0.888).

## v0.8.11 — DAY_CAP 4000 → 10000 + queue flush (2026-06-11, afternoon)

Second budget exhaustion in two days: 4,000 spent by mid-afternoon (608-cam zone + the
bar dropping 0.83→0.80 through the day + ~1,900 one-off re-bucket promotions flooding the
ranked pages). User raised the cap to **10,000 (50 pages/day)** and asked for the queue now:
**956 queued candidates flushed immediately** in 5 pages (4,956/10,000 after flush).

## Dashboard v2.3 — camera grouping: one dot per camera, paged popup (2026-06-11)

Cameras with repeat sightings (Old Kent Rd ×3, A2 New Cross ×2) stacked identical
dots on the same coordinates — unselectable. Now:

- **One marker per camera**: ring colour/size from the NEWEST sighting; when a camera
  has more than one, the dot grows to 20px and shows the count in the centre
  (number tinted to match the ring).
- **Paged popup**: opens on the newest sighting with ‹ › arrows + "1 / N" to walk
  every sighting at that camera (newest → oldest); every record stays live on the
  dash. Arrows disabled at the ends; popup always reopens at the newest.
- Same popup layout per page (reserved image box → no resize while paging).

## Dashboard v2.2 — moved to https://waymonet.com (2026-06-11)

The public dashboard moves off GitHub Pages onto its own domain (Namecheap),
served by the VPS nginx that already hosts the sightings API:

- **Dashboard source relocated** to `projects/waymowatch/site/` (index.html +
  assets); the old `projects/waymowatch/index.html` is now an instant-redirect
  stub to waymonet.com (bookmarks keep working).
- **nginx vhost `waymonet`** (VPS): serves the static site and proxies `/api/`
  + `/img/` to the sightings API on 127.0.0.1:3104 — the page is now
  SAME-ORIGIN (`API_BASE = ""`); the axiom.hjd.ai preconnect + CORS dependency
  are gone from the page. The `axiom.hjd.ai/waymowatch/` route stays up for
  any cached old pages.
- **Deploy**: `rsync -az site/ root@89.167.4.126:/var/www/waymonet/` —
  dashboard changes no longer need a merge to main to publish (only the
  redirect stub and projects.html live on GitHub Pages).
- **projects.html**: link renamed WaymoWatch → WaymoNet, points at
  https://waymonet.com.
- SSL via certbot (waymonet.com + www.waymonet.com), DNS A record → 89.167.4.126.

## v0.8.10 — Confirms 30-31 (#8770, #8818) + both bars moved (2026-06-11, afternoon)

**#8770** (00001.06608 A4 Cromwell Rd/Gloucester Rd, 13:30 — new cam, near #3696's
Cromwell Rd territory) and **#8818** (00001.09702 Angel Islington, 13:49 — new cam,
pushing NORTH). **31 confirms / 28 distinct cameras.**

- Standard cycle: 31-real centroid; archive re-scored (n=9,037: p80 0.849 / p95 0.873 /
  max 0.920; reals 0.816-0.914).
- **PROB_TH 0.81 → 0.80**: floor reals slid again (0.819 → 0.816, margin 0.006) —
  restored to 0.016. 1,091 promoted / 0 demoted at the wider bar.
- **ALERT_TH 0.92 → 0.93**: one FP reached 0.920, breaking the old bar — raised back
  above all known FPs. NEAR_TH 0.76 unchanged (floor real comfortably above).
- 4 sheets emailed: echo-mining around each confirm (851 + 705 in window) + top-200 retro
  (0.907..0.849) + top-100 rejects re-check (0.920..0.889).

## v0.8.9 — Confirms 28-29 (#8435, #4574) + roof-box #5 (2026-06-11, afternoon)

**#8435** (00001.07393 Baker St/Marylebone Rd, 12:42 — a second Marylebone-area spine cam)
and **#4574** (00001.07590 Southampton Row/Vernon Place, 13:04 — Holborn, new cam; captured
0.812, now the FLOOR real at 0.819). **29 confirms / 26 distinct cameras.** **#8604**
(Battersea Rise/Northcote Rd) added to `data/special/roof-box/` (5th specimen, 4th distinct
camera) + rejected.

- Standard cycle: 29-real centroid; archive re-scored (n=8,678: p80 0.846 / max 0.915;
  reals 0.819-0.915 — three reals cluster 0.819-0.821 just over the bar; margin 0.009,
  watch per re-seed). Bars unchanged: PROB_TH 0.81 / NEAR_TH 0.76 / ALERT_TH 0.92
  (no FP >=0.92). 232 promoted / 20 demoted.
- 4 sheets emailed: echo-mining around each confirm (827 + 673 in window) + top-200 retro
  (0.885..0.848) + top-100 rejects re-check (0.915..0.887).

## v0.8.8 — Confirm 27 (#4362 Harrow Rd) (2026-06-11, afternoon)

**#4362** (00001.07376 Harrow Rd/Kilburn Lane, 12:28 — NW London, new cam; captured at
0.828, below non-waymo p80: the ranked channel surfacing what no fixed bar would).
**27 confirms / 24 distinct cameras.**

- Standard cycle: 27-real centroid; archive re-scored (n=8,402: p80 0.844 / max 0.914;
  reals 0.822-0.915 — floor margin over PROB_TH back to a healthy 0.012). Bars unchanged:
  PROB_TH 0.81 / NEAR_TH 0.76 / ALERT_TH 0.92 (no FP >=0.92). 66 promoted / 55 demoted.
- 3 sheets emailed: echo-mining around #4362 (615 in window) + top-200 retro
  (0.904..0.849) + top-100 rejects re-check (0.914..0.884).

## v0.8.7 — Confirm 26 (#8075 Park Lane) + PROB_TH 0.81 (2026-06-11, afternoon)

**#8075** (00001.08751 Park Lane Opp Stanhope Gate, 11:54) — a SECOND Park Lane camera
~90 min after #7361's sighting there: likely the same vehicle working Mayfair.
**26 confirms / 23 distinct cameras.**

- Standard cycle: 26-real centroid; archive re-scored (n=8,163: p80 0.843 / max 0.914;
  reals 0.821-0.914). **PROB_TH 0.82 → 0.81**: floor real #2145 slid again
  (0.824 → 0.821), leaving a 0.001 margin that the next re-seed would likely break —
  dropped a notch to restore the recall buffer. NEAR_TH 0.76 / ALERT_TH 0.92 unchanged
  (no FP ≥0.92). 10+786 promoted (re-bucket at 0.82 then widened to 0.81), 126 demoted.
- 3 sheets emailed: echo-mining around #8075 (661 in window) + top-200 retro
  (0.897..0.855) + top-100 rejects re-check (0.914..0.883).

## v0.8.6 — Confirm 25 (#7511 Jamaica Road) + roof-box #4 (2026-06-11, midday)

**#7511** (00002.00434 A200 Jamaica Road, 10:46 — Bermondsey, new cam, the south-east
corridor again). **25 confirms / 22 distinct cameras.** **#2126** (Clapham Rd, 06:11)
added to `data/special/roof-box/` (4th roof-box specimen, 3rd distinct camera) + rejected.

- Standard cycle: 25-real centroid; archive re-scored (n=7,742: p80 0.844 / max 0.914;
  reals 0.824-0.914). Bars unchanged: PROB_TH 0.82 / NEAR_TH 0.76 / ALERT_TH 0.92
  (no FP >=0.92). 5 promoted / 188 demoted.
- 3 sheets emailed: echo-mining around #7511 (772 in window) + top-200 retro
  (0.889..0.853) + top-100 rejects re-check (0.914..0.884).

## v0.8.5 — Confirms 21-24 (2026-06-11, midday)

**#7361** (Park Lane/Upper Grosvenor St, 10:25 — Mayfair, new cam), **#5083** (Victoria
St/Bressenden Place, 07:14 — new cam), **#2669** (Old Kent Rd/Glengall Rd, 09:22 — that
camera's THIRD confirm: #1338, #4382, #2669), **#1329** (Vauxhall Brd Rd/Drummond Gt,
05:12 — new cam, another night capture). **24 confirms / 21 distinct cameras.**

- Standard cycle with confirm-echo emails (each mining mail leads with the banked
  vehicle's own crop+frame for id verification).
- 24-real pure centroid; archive re-scored (n=7,413 non-waymo: p80 0.846 / p95 0.870 /
  max 0.916; reals 0.824-0.913 — #2145 floor 0.824, #1329 second-weakest 0.830).
- **Bars unchanged**: PROB_TH **0.82** (still below the weakest real), NEAR_TH **0.76**,
  ALERT_TH **0.92** (no FP ≥0.92; 28 sat 0.90-0.916). 435 promoted / 12 demoted.
- 6 sheets emailed: 4 echo-mining + top-200 retro (0.916..0.867) + top-100 rejects
  re-check (0.913..0.881).

## v0.8.4 — Confirms 17-20 + confirm-echo verification in mining emails (2026-06-11, morning)

Four overnight/early-morning confirms off the first two digests of the new day: **#4382**
(Old Kent Rd, 05:28 — REPEAT camera, #1338's site), **#4752** (Camberwell New Rd, 05:09 —
new cam), **#4539** (Stamford St, 04:32 — new cam), **#3424** (A2 New Cross Rd/Florence Rd,
07:33 — REPEAT camera, #3310's site). **20 confirms / 18 distinct cameras.** First repeat
cameras = the SE corridor (A2/Old Kent Rd) is a regular route; first 04:00-05:00 captures
chip at the night-data gap.

- **NEW STANDING RULE (user)**: every mining email now leads with the confirmed vehicle's
  OWN crop + frame and an "if this is NOT a Waymo, reply 'undo #id'" line — an id typo can
  no longer silently bank a non-Waymo into the training positives.
- Standard cycle: 20-real pure centroid; archive re-scored — **n=7,364 non-waymo (nearly
  doubled overnight: the 608-cam zone producing)**: p80 0.841 / p95 0.866 / max 0.913;
  reals 0.829-0.915. 1,085 promoted / 0 demoted.
- **Bars**: PROB_TH **0.83 → 0.82** (the floor real #2145 re-scores 0.829; eligibility
  stays below the weakest known real), NEAR_TH **0.76**, ALERT_TH **0.92** (no FP ≥0.92).
- 6 sheets emailed: 4 mining (each with confirm echo) + top-200 retro (0.910..0.862) +
  top-100 rejects re-check (0.913..0.875).

## v0.8.3 — Confirms 15-16 (#1362, #332) (2026-06-10/11, midnight)

**#1362** (00001.03663 A2 New Cross Rd/St James, 19:42 — the A2 corridor's SECOND confirm,
fourth east-pointing one; the v0.8 east extension is watching the right roads) and **#332**
(00001.06650 Holland Rd/Addison Crescent, 21:53 — a new WESTERN camera). **16 confirms /
16 distinct cameras.**

- Standard cycle: 16-real pure centroid; archive re-scored (n=4,106 non-waymo: p80 0.835 /
  p95 0.861 / max 0.910; reals 0.838-0.919 — the floor ROSE 0.834→0.838, scale stabilising).
  41 promoted / 64 demoted.
- **Bars unchanged** (the new scale lands where the bars already were): PROB_TH **0.83**
  (still below the weakest real), NEAR_TH **0.76**, ALERT_TH **0.92** (FP max 0.910,
  margin widened 0.007→0.010).
- 4 sheets emailed: mining ±45 min around each confirm, top-200 retrospective
  (0.895..0.836), top-100 rejects re-check (0.910..0.870).

## v0.8.2 — Confirms 13-14 (#161, #4036) + special hard-negative folders (2026-06-10, night)

Both came off the recovered-58 sheet (the candidates stranded by the old 1600 budget —
the recovery run earned its keep immediately): **#161** (00001.07364 Marylebone Rd/Osnaburgh
St, 19:41 — the SPINE) and **#4036** (00001.02252 Commercial Rd/Gowers Walk, 20:42 — east
again, third confirm pointing at/past the old zone edge). **14 confirms / 14 distinct
cameras in one day.**

- Standard cycle: 14-real pure centroid re-seeded; whole archive re-scored from stored
  embeddings (n=4,099 non-waymo: p80 0.836 / p95 0.861 / max 0.913; reals 0.834-0.917,
  #2145 still the floor). 206 near→new promoted, 0 demoted.
- **Bars (14-real scale)**: PROB_TH **0.83** — now anchored just BELOW the weakest real
  view (0.834) rather than at p80 (recall-first: eligibility covers every known-real
  strength; the 4000 DAY_CAP governs sending). NEAR_TH **0.76** unchanged. ALERT_TH
  **0.92** (above all 4,099 known FPs, max 0.913).
- 4 sheets emailed: mining ±45 min around each confirm (cosine-to-confirm ranked),
  top-200 retrospective (0.892..0.837), top-100 rejects re-check (0.913..0.871).
- **`data/special/` hard-negative gallery (user-curated, VPS)**: `roof-box/` = #4014 +
  #4015 (two white cars with black roof boxes, SAME clip on 00001.06549 — brilliant dome
  impostors) and `i-pac/` = #4034 (a non-Waymo I-PACE — potentially the hardest negative
  in the pool). All three also banked as normal rejects (suppression + training); the
  folders preserve them against the 7-day prune for special attention at training time.

## v0.8.1 — Hourly candidate backup to GitHub (2026-06-10, night)

User created a private repo (`hdonovan42/waymo`) for off-VPS preservation of the Phase-3
collection: candidate data was perishable (7-day retention prune + best-view dedup deletes
superseded jpgs), so everything above the archive floor survived only a week, on one disk.

- **`backup_github.sh` — lives IN the waymo repo itself** (user: backup tooling goes to
  `waymo`, not stored in `H`; deployed at `/home/hq/waymo-backup/backup_github.sh`).
  Hourly cron (:37) on the VPS: rsyncs every candidate jpg (crop + frame; excludes
  transient sheets/log/heartbeat) into the repo clone, dumps full `candidates.csv`
  (no emb column — embeddings are recomputable from crops with the committed MobileNetV3
  code) + `cameras.csv`, commits and pushes. **APPEND-ONLY**: `--ignore-existing`, no
  `--delete` — the repo keeps what the VPS prunes. flock-guarded; no-op when unchanged.
- Auth: new VPS deploy key `id_ed25519_waymo` (write access, repo-scoped) via the existing
  per-repo ssh-alias pattern (`Host github-waymo`).
- Initial backfill pushed: **4,088 rows / 8,212 jpgs (~217MB)** incl. all 12 confirms,
  1,008 vetted rejects, and the real_positives gold set. Idempotency verified (second run
  = no commit).
- **What to watch**: repo growth (~200MB/day at the v0.8 capture rate → GitHub's soft
  ~5GB guidance in roughly a month). If Phase 3 runs long: drop vehicle crops from the
  backup (frames+bbox reconstruct them) or rotate to a `waymo-2` repo. `data/backup.log`
  shows the real rate.

## v0.8 — Coverage push: zone extended EAST + archive floor lowered (2026-06-10, night)

User: "what can we do to maximise coverage — we don't want to miss waymos." Measured first,
then spent the headroom the measurement revealed:

- **Measured poll headroom**: per-cam refresh EMAs (n=507) put the TRUE fleet refresh floor
  at **267s** (p5 270 / p50 422) — not the ~180s TfL nominal that sized POLL_EVERY=150.
  Cycles ran ~158s on 494 cams → ~100s of spare cycle time before any clip could be skipped.
- **Zone box extended east**: lon1 -0.02 → **+0.06** (494 → ~608 cams). Three of the 12
  confirms hugged the old east edge (#3310 A2 New Cross 0.009°, #2605 Limehouse 0.022°,
  #1338 Old Kent Rd 0.052°) and both corridors continue east — we were watching the fleet
  drive out of frame. New coverage: Greenwich, Lewisham/A21, Canary Wharf. Projected cycles
  ~190s, comfortably under the 267s refresh floor. All-London (778 cams) deliberately NOT
  taken: ~215-230s cycles = saturation with no burst margin; revisit after a day at 608.
- **NEAR_TH 0.80 → 0.76** — the archive floor is the funnel's ONLY irrecoverable cut
  (everything above it is re-rankable forever from stored embeddings on each re-seed).
  Hardest confirmed real #2145 CAPTURED at 0.813, just 0.013 over the old floor, and the
  real floor drops as harder views join. Disk trivial (216MB used / 54GB free, 7-day prune).
- Sending untouched: PROB_TH / DAY_CAP / ALERT_TH unchanged — digest volume should not move.
- **What to watch**: cycle secs (expect ~190s; sustained >240s = trim the box), dropped count
  on the first post-deploy cycles (~114 no-ETag new cams = one-off fetch burst), near-row
  volume over the week, and whether the new east cams start producing confirms.
- **DAY_CAP 1600 → 4000** (user, same night): all 8 pages were spent by ~20:30 and the 23:00
  remainder-flush had nothing left to send (55 unsent demoted to near) — review budget raised
  to 20 pages/day to match the user's actual appetite + the wider zone's volume.

## Dashboard v2.1 — serving trims: London-clamped, self-hosted assets (2026-06-10, late night)

Measured audit first (multi-agent: live curl measurements, tile math, licensing research,
adversarial verification): first load is ~1.4MB desktop / ~1.1MB mobile, of which ~95% is
CARTO tile PNGs; the fixed page was only 72.8KB but spread across 9 origins, with
render-blocking Leaflet on un-preconnected unpkg.com and the sightings JSON uncompressed.
Raster tiles fetch per-viewport, so no "rest of the world" data was ever shipped — the
real waste was origins, retina tile weight (@2x = 2.76x plain) and an unclamped map.

Trims shipped (no visual change):
- **Map clamped to London**: maxBounds [[51.25,-0.60],[51.75,0.45]] viscosity 1.0,
  minZoom 10, maxZoom 16 (was: unbounded, z19) — caps worst-case tile spend.
- **Leaflet self-hosted**: leaflet.js 1.9.4 → `assets/` (sha256 verified against the
  official dist), leaflet.css inlined into the HTML — kills the render-blocking
  unpkg.com origin entirely.
- **Font self-hosted**: Hammersmith One latin woff2 (19.6KB, SIL OFL 1.1, licence in
  `assets/OFL-HammersmithOne.txt`) + preload; both Google Fonts origins gone (browser
  font caches are per-site since 2020, so the shared-cache argument was already dead).
- **API**: preconnect to axiom.hjd.ai; nginx now serves the sightings JSON gzipped
  (2,776 → 1,007 B per 60s poll) and the axiom vhost speaks HTTP/2.
- Page origins: 9 → 3 effective (hjd.ai, cartocdn [HTTP/2-coalesced], axiom.hjd.ai).

Audit findings banked for later: CARTO free tiles are tolerated-but-revocable (ToS:
grant-only, 1M tiles/mo, server-side proxy-caching explicitly forbidden); ready fallback
= Greater-London PMTiles extract (132MB measured via `pmtiles extract --dry-run`,
44MB watch-zone) on VPS nginx + protomaps-leaflet (37.7KB gz, light flavour), or
self-rendered Positron raster via TileServer GL (style is BSD/CC-BY). GitHub Pages is
unsuitable for PMTiles (100MB file limit + Firefox range-caching bug).

## Dashboard v2 — 2D-only rewrite: Leaflet + raster (2026-06-10, night)

User retired 3D entirely ("always 2d... how best can we serve 2d?"). With no extrusions,
vector tiles + WebGL + the tile-caching service worker were all dead weight, so the
serving stack restarts from first principles:

- **Leaflet 1.9 + CARTO Positron raster tiles** replace MapLibre + OpenFreeMap vector:
  ~42KB JS (was ~300KB + WebGL init), no style/glyph/sprite round-trips — pre-rendered
  CDN PNGs paint as they arrive and ride the plain HTTP cache. Same paper aesthetic;
  key panel/popup/footer design carried over (popups restyled onto Leaflet classes,
  station-dot markers as CSS divIcons, past-hour pulse via CSS animation, honours
  prefers-reduced-motion).
- **Service worker deleted** (sw.js removed); the page actively unregisters old workers
  and clears their caches from returning visitors.
- **Change-aware polling**: 60s tick rebuilds markers only when the sightings payload
  (or a dot's recency bucket) changes — an open popup is never yanked by a no-op refresh.
- 2D/3D buttons gone; default view unchanged (Mayfair, z11). Attribution now includes
  "Powered by TfL Open Data" (OGL requirement).
- API contract untouched: same `/api/sightings` + `/img/<id>_frame.jpg` endpoints.

## v0.7.4 — Confirms 10-12 (#1208, #3696, #2145) (2026-06-10, night)

Three from one ranked page: **#1208** (00001.07369, 19:38), **#3696** (00001.06600, 18:25),
**#2145** (00001.07326, 19:27 — original capture score 0.813, re-scores 0.836: the hardest
real view yet, below non-waymo p95 — the ranked DAY_CAP channel caught what no fixed bar
would have). 12-real centroid; archive re-scored (n=3,951: p80 0.828 / max 0.907; reals
0.836-0.920 — floor widened as harder views joined, expected and healthy for training
diversity). Bars: PROB_TH **0.83** / NEAR_TH **0.80** / ALERT_TH **0.91**. 3 mining sheets
+ retro + rejects re-check emailed. **12 confirms / 12 distinct cameras in one day.**
Sheets reviewed clean by user -> 277 banked: **1,008 vetted negatives**, clearing the TOP of
the 600-1,000 training target. The negative side of the dataset is now done growing on
purpose — confirms are the only scarce resource left.

## Day close 2026-06-10 — 9 confirms / 9 cameras / 731 vetted negatives

User reviewed the 9-real sheets: no further Waymos; mining-60 + retro-200 banked as vetted
negatives (233 new, 731 total — past the 600 lower bound of the training-negative target).
Day started with 0 all-time confirms and a provably blind scorer; ends with 9 reals across
9 cameras (incl. two simultaneous vehicles), a pure-real scorer re-anchored after every
confirm, 731 human-verdicted hard negatives, and the live map showing all nine. Loop runs
overnight (night captures = the negative pool's known gap). Next milestone: ~100 confirms
across ≥5 cams -> YOLO26 training run (pipeline built + CPU-tested, waiting on data only).

## v0.7.3 — Ninth confirm (#3620), surfaced BY the re-seed (2026-06-10, night)

**#3620 (00001.04607, 17:50 London)** — found on the 8-real retrospective itself: the
flywheel's compounding step working as designed (re-seed -> re-rank -> human -> new real ->
re-seed). 9-real centroid deployed; archive re-scored (n=3,647: p80 0.810 / max 0.900;
reals 0.871-0.915, floor still rising 0.868->0.871). Bars: PROB_TH **0.81**, NEAR_TH 0.78,
ALERT_TH **0.91** (margin to FP max back to 0.01). Mining + retro + rejects sheets emailed.
**9 confirms / 9 distinct cameras in one day.**

## v0.7.2 — Eighth confirm (#1700) (2026-06-10, night)

**#1700 (00001.07389, 17:26 London)** from the 17:45 ranked page. Standard cycle: confirm
-> 8-real pure centroid -> archive re-scored (n=3,646 non-waymo: p80 0.817 / max 0.907;
reals 0.868-0.916 — **the real FLOOR is rising with each view**: 0.855 @7 -> 0.868 @8) ->
bars PROB_TH **0.82** / NEAR_TH 0.78 / ALERT_TH **0.91** (FP max 0.907 — margin thin,
watching) -> loop restarted -> mining + retro + rejects-re-check sheets emailed.
8 confirms / 8 cameras in one day.

## v0.7.1 — 7 confirms: TWO SIMULTANEOUS Waymos (2026-06-10, night)

**#722 (00001.07379) and #1338 (00001.03654) — captured 29 seconds apart on different
cameras (15:56:24 / 15:56:53)**: first direct evidence of two fleet vehicles operating
concurrently. Both surfaced by the pure-real retrospective (top and bottom of its range —
0.890 and 0.823 — the ranked-sheet recall channel working at both ends).

- Confirmed -> **7 reals**, centroid re-seeded (pure real), archive re-scored (n=3,486
  non-waymo: p80 0.814 / p95 0.841 / max 0.904; reals 0.855-0.916).
- Thresholds (7-real scale): PROB_TH **0.81** (p80), NEAR_TH **0.78** (~p50), ALERT_TH
  **0.91** (above all known FPs; catches #722/#738-strength views).
- 4 sheets emailed: mining around both confirms (shared 15:11-16:41 window, per-confirm
  similarity ranking) + top-200 retrospective + top-100 rejects re-check.
- Note: #722's id predates its captured_at — best-view dedup UPDATES a row in place
  (captured_at moves to the better view). Id = insert order of the VEHICLE entry, not the
  final capture time.
- **Leave-one-out calibration audit** (user asked what the 7 sightings actually bought):
  each real scored against a centroid of the OTHER six, ranked vs 3,568 known non-Waymos —
  **all 7 land on page one of the daily ranked sheets as unseen vehicles** (FPs above:
  0, 0, 7, 11, 45, 131, 169); LOO within ~0.01 of in-centroid scores = the centroid
  GENERALISES across views, it doesn't memorise. Per-view variance (0.841-0.916) remains
  the structural limit: the frozen ImageNet embedding mostly encodes photometrics (dome
  moves the score only ~+0.07) — scorer is a SURFACER; the trained YOLO26 is the detector.
- **Nearest-view scoring REJECTED** (same harness): max-cosine over the 7 views loses to
  the mean centroid on ALL 7 reals (#722: 0 FPs above -> 156) — max gives every impostor
  seven chances to match one view; the mean cancels view-specific noise and keeps the
  shared (dome) component. Zero-cost upgrade space is now exhausted by measurement:
  probe (overfits), hardware centroid (no gain), nearest-view (worse). DAY_CAP 1600 noted
  as a designed knob (8 pages × 200, sized above expected steady-state as a flood ceiling),
  not a derived constant — tune to review appetite; ranking decides WHAT, the cap only
  decides HOW MANY.

## v0.7 — PURE-REAL SCORER: 5 confirms, synthetic blend retired (2026-06-10, night)

Confirms #4 and #5 from the 16:56 ranked page: **#1581** (00001.04250, 15:09 London) and
**#3310** (00001.03664, 16:41 London — **first FRONTAL view**, new viewpoint for the
centroid). Five reals = MIN_REAL: `reseed_from_real.py` dropped the synthetic blend — the
scorer now runs on confirmed real Waymos ALONE. The #491 mining sheet (0 Waymos, user-
reviewed) banked as 72 more vetted negatives (498 rejects total).

**The pure-real scale is a step change** (archive re-scored, n=3,442):
- Reals: **#738 0.914 / #1581 0.913 / #491 0.912 / #3310 0.911** / #2605 0.862 — four of
  five ABOVE every one of 3,437 known non-Waymos (FP max 0.895); #2605 at p99.2.
- Thresholds (NEW SCALE): PROB_TH **0.80** (live p80, as ever), NEAR_TH **0.76** (≈p50,
  keeps the silent band's volume), ALERT_TH **0.90** — above ALL known FPs yet below 4/5
  real views: **the instant-alert channel is precise AND sensitive for the first time**.
  Watch the live FP tail for a day (always fatter than the archive).
- 4 sheets emailed: mining for #1581 + #3310 (similarity-ranked, ±45 min), pure-real
  top-200 retrospective, top-100 rejects re-check (standing process).
- Confirms now span 5 cameras / 5 distinct views across one day: KX (09:09), depot corridor
  (11:10), 00001.04250 (15:09), Limehouse (15:26), 00001.03664 frontal (16:41) — enough
  camera diversity that build_real_dataset's by-camera split is already viable.

## v0.6.3 — THIRD CONFIRM (#738, King's Cross) rescued FROM THE REJECTS + 3-real re-seed (2026-06-10, late)

**#738, Kings X Rd/Swinton St (00001.03591), 09:09 London** — one of the original 8 KX FOCUS
cams; the user's "I've seen them in King's Cross" intel, finally vindicated by the data.
Found by the user RE-REVIEWING the 16:06 retrospective… **after it had been bulk-banked into
the reject pool** — a real Waymo sat in the training negatives. The poisoning scenario was
real; the defence that worked was process (re-show + re-review on each recalibration), not
the deleted similarity quarantine.

- v0.6.2 (UX session's work) AUDITED: #491 banked correctly, 2-real centroid deployed both
  sides, thresholds consistent, archive re-scored, loop healthy. No corrections needed.
- #738 confirmed (`--confirm 738`) -> 3 reals; centroid re-seeded (still 50/50 blend <5).
- **Whole archive re-scored on the 3-real scale** (3,397 rows): reals **#2605 0.920 /
  #491 0.902 / #738 0.898** (tight cluster); non-waymo n=3,394 p80 0.829 / p95 0.856 /
  max 0.916. 201 promoted, 3 demoted.
- **Thresholds unchanged** (anchoring landed where they already were): PROB_TH 0.83 (~p80),
  NEAR_TH 0.80, ALERT_TH 0.92 (one FP outlier at 0.916 still outranks two reals — alerts
  stay the precision channel, ranked sheets the recall channel).
- **Retrospective email, 2 sheets**: top-200 unconfirmed (0.901..0.845) + **top-100 REJECTS
  re-ranked** (0.916..0.852) — bulk-cleared verdicts now get a standing re-check after every
  re-seed. Both #491-class facts hold: all 3 reals captured by the SPINE/KX cams hours
  before the zone expansion; ids are insert-order (low id = earlier same-day, not old).
- **Lesson banked**: a bulk "sheet is clean" verdict is weaker than a per-vehicle verdict;
  treat mass-banked rejects as provisional and re-surface the top of them on each new scale.

## v0.6.2 — SECOND CONFIRM (#491, depot corridor) + 2-real re-seed (2026-06-10, late)

**#491, A40/Wales Farm Rd (00001.07308), 11:10 London — the Park Royal depot corridor.**
Scored 0.841 on the v0.6 scale (bar 0.84): eligible by 0.001. It reached the user's eyes
via the ranked digest. Phase-2 pattern re-executed:

- Confirm banked (`--confirm 491`); dashboard showed the second dot automatically within
  its 60s poll — first live test of the auto-update path, no code touched.
- **Centroid re-seeded with 2 reals** (still 50/50 synthetic blend until 5): reals re-score
  **#2605 0.933 / #491 0.891**; whole archive re-scored from stored embeddings
  (3,350 rows; non-waymo n=3,348: p50 0.805 / p80 0.833 / p95 0.857 / max 0.913);
  133 near→new promoted, 179 new→near demoted.
- **Thresholds re-anchored (NEW SCALE, v0.6 numbers incomparable)**: PROB_TH **0.83**
  (≈ live p80, same anchoring as v0.6), NEAR_TH **0.80**, ALERT_TH **0.92** (archive FP
  max 0.913 — #2605-strength repeats alert; #491-strength reaches sheets via ranking).
- **Mining sheet emailed**: 155 candidates ±45 min of #491, all cameras, ranked by
  embedding cosine to #491 (rejects excluded — already vetted); top-72 sheet sent for
  review. Flagged ones become real training views → re-run reseed.
- Loop restarted on the new artifact + thresholds.

## v0.6.1 — Dashboard wired to the real sightings DB (2026-06-10, evening)

The map now shows the real confirm (#2605) instead of demo data — Phase 6 (sighting feed)
has begun, pre-model interface behaviour: one dot per confirmed sighting, auto-updating.

- **`server/sightings_api.py`** — read-only stdlib HTTP API on 127.0.0.1:3104 (systemd
  `waymowatch-api.service`, user hq): `GET /api/sightings` (status='waymo' rows joined
  with camera name/view/lat/lon, newest first) + `GET /img/<id>[_frame].jpg`. Images are
  served ONLY for confirmed rows — unreviewed candidates stay private. CORS `*` (the data
  is what the public map shows anyway), sightings no-store, images cacheable 24h.
- **Exposed at `https://axiom.hjd.ai/waymowatch/`** via a new auth-free location block on
  the axiom vhost (no Cloudflare credentials on the VPS to mint a waymowatch.hjd.ai
  record + cert; swap to its own subdomain later if DNS is added).
- **Dashboard demo data deleted** — the fictional corridors/weekly counts and 26 fake
  sightings are gone. The map fetches the live feed on load and **polls every 60s**, so
  new confirms appear without a reload. One dot today: Limehouse.
- **Popup per sighting**: annotated JamCam frame, camera name (+ facing direction),
  date + time (Europe/London), detector score, recency chip. Recency (hour/today/week
  rings) computed client-side from `captured_at`.
- Footer shows confirmed count + latest sighting time; reads "Sightings feed
  unreachable" if the API is down.

## v0.6 — FIRST CONFIRMED REAL WAYMO + real-blended scorer (2026-06-10, evening)

**#2605, Limehouse Tunnel/Butcher Row (00002.00361), 15:26 London — white I-PACE, dark roof
dome, user-confirmed from the ranked digest.** Two design decisions paid off in one capture:
it scored 0.868 (below the old 0.88 bar — only the v0.5.1 RANKED sending put it on a sheet),
and it was in EAST London (only the v0.5 zone-wide expansion was watching there).

Phase 2 of the roadmap executed same-hour:
- **Confirm banked** (`--confirm 2605` -> data/real_positives/); the 0.926 grey-Mini FP
  (#2602) rejected — top-of-page score being a FP while the real Waymo sat mid-page is the
  frozen-embedding ceiling in one image.
- **Archive mined by SIMILARITY**: 1,082 candidates ±45 min, ranked by embedding cosine to
  #2605 (not by dome score) -> top-72 sheet emailed for review; any flagged = more reals.
- **Centroid re-seeded** (`reseed_from_real.py`): 1 real < MIN_REAL=5 -> 50/50 blend with
  synthetic. Separation jump: real re-scores **0.944** vs white-car reference max 0.862
  (old scale had the real at 0.868 UNDER the 0.926 FP).
- **Whole archive re-scored from stored embeddings** (2,865 rows) on the new scale:
  live p50 0.816 / p95 0.867 / p99 0.884 / max 0.919 (fatter than synthetic reference, as
  always); 313 promoted to eligible, 375 demoted.
- **Thresholds re-anchored (NEW SCALE, incomparable to v0.5.x)**: PROB_TH **0.84**
  (eligibility only — ranked DAY_CAP still governs sending), NEAR_TH **0.80**, ALERT_TH
  **0.92** (live archive max 0.919 sits just under; the real at 0.944 clears it — a repeat
  sighting should fire an instant alert). RE-CHECK against 24h of live tails.
- **What to watch**: alert FP rate at 0.92 (archive tail 0.919 is close); digest volume at
  0.84 eligibility; flagged vehicles from the mining sheet -> re-run reseed (pure-real at
  5+ confirms).
- **Record settled (same evening)**: user reviewed the similarity-mined 72 AND the re-scored
  top-200 of the entire archive — **no other Waymos; dataset is one-Waymo clean**. All
  reviewed vehicles banked as vetted hard negatives (427 total rejects now) — the
  highest-value negative set possible: the closest impostors under the real-seeded scorer,
  human-cleared. They feed build_real_dataset (hard-neg backgrounds) + eval_gate (FP test)
  automatically and permanently suppress on the live sheets.
- **Negative-set curation (post-confirm)**: all rejects re-scored onto the v0.6 scale (older
  ones carried old-scale scores — RE-SCORE REJECTS AFTER EVERY RE-SEED or hardest-first
  selection corrupts). Pool: 427 frames / 193 cams, 234 still >=0.86; target 600-1,000 by
  training time via verdict-banked sheets; remove nothing (suppression + build-time cap).
  Gap to fill: night = 20/427 — bank late-hour sheets toward ~25-30%. Stage2's 233 crops
  DEMOTED to scorer-regression-only (mostly easy under the real scorer: 4/229 >= 0.86; no
  frames/bboxes so the detector can't use them anyway). 4 hidden test crops stay hidden.
- **Verdict-only training labels** (supersedes the short-lived similarity quarantine, which
  the user correctly rejected — it routed the most informative hard negatives AROUND
  training and added builder complexity): build_real_dataset now uses **explicit rejects
  ONLY** as negatives, highest score first (hardest impostors are the most valuable),
  capped 6:1. The implicit channel (sent-but-unflagged) is deleted — a missed Waymo can no
  longer become a training negative BY CONSTRUCTION, with zero screening machinery.
  Negative growth = the established review pattern: user declares a sheet clean -> page
  banked as rejects (427 and counting). Builder warns if held-out cameras lack negatives
  (eval_gate needs them; preflight also catches it).

## v0.5.2 — New dashboard UI: tube-map sighting feed (2026-06-10)

Replaced the base-map prototype `index.html` with the new tube-map-styled dashboard
(user-supplied design, from `temp/`):

- **MapLibre + OpenFreeMap Positron** restyled to TfL paper/ink palette (Hammersmith One
  display face); corridors drawn as tube lines (City spine red, Westway blue, South circuit
  dashed green) with click popups + key-row toggles.
- **Sightings as station-style markers** ringed by recency (past hour = red + pulse,
  today = blue, week = grey); demo data inline — wire to the real API later (Phase 6).
- **2D/3D toggle** with pre-mounted building extrusions (opacity fade + animated height
  rise, no tile pop-in); respects prefers-reduced-motion.
- **`sw.js` service worker**: cache-first tile/font/CDN persistence (~6k entries),
  stale-while-revalidate for the style JSON — repeat visits load instantly, works offline.
  Only active when served over http(s).
- Tweaks vs the supplied design (user-requested): map defaults to the **British Library**
  as centre (51.5300, -0.1276, z13.2) instead of a fitted central-London bounds; 2D/3D
  buttons flattened — two-colour top-stripe accent and box-shadow removed, single colour.
- **Idle prefetch (first-press 3D lag fix)**: the 3D toggle eases to z14.4, needing z14
  tiles the opening z13.2 view never loaded — fetching them mid-animation was the visible
  hitch (the SW only helps on the SECOND request). On first map idle, the z14 tiles for
  the pitch-padded viewport (±40%) are trickle-fetched (4 lanes, low priority, capped at
  120) through the service worker, so the rise to 3D never waits on the network — even on
  the very first visit (sw.js claims the page immediately via skipWaiting+clients.claim).

## v0.5.1 — Recall to human eyes: score-ranked budgeted sending (2026-06-10, later)

User: "some will be waymos — you need to make sure they are sent to me or this is all for
nothing." The 0.88 threshold failed that test: synthetic-proxy Waymo views score p50 0.836 /
p90 0.875, so a fixed bar either floods the reviewer or silently bins most real passes (the
overlap is the frozen-embedding ceiling — no threshold fixes it). Sending is now RANKED, not
thresholded:

- **DAY_CAP=1600** cells/day (8 pages of 200): the user's review budget is the constant; each
  page emails the HIGHEST-scoring unsent candidates, so the effective score cut floats with
  volume and the user always sees the day's most-dome-like vehicles.
- **PROB_TH 0.88 -> 0.86** = eligibility only (pool for ranking, ~synthetic p80).
  **NEAR_TH 0.86 -> 0.80**: the silent archive now spans the band real Waymos are PREDICTED
  to occupy (p10 0.754... most mass >= 0.80) — bars can be re-cut retroactively, confirms
  mined; nothing above 0.80 is ever unrecoverable (~300MB/day disk, 7-day prune).
- **Per-row `sent` flag** replaces the last_digest_id high-water mark (set only on successful
  send -> transient email failures retry). End-of-day: unsent overflow demoted to the near
  archive (fresh ranking each day) — EXCEPT unsent alert-level rows (>= ALERT_TH), which stay.
- Migration: 87 already-emailed rows marked sent; 273 near rows >= 0.86 promoted into
  tonight's ranked pool.
- **Why this maximises P(Waymo reaches the user):** per-view P(sent) at the floating cut
  (~0.86-0.87 zone-wide) is ~15-25%, but the fleet generates many scored views/day across 484
  cams -> P(>=1 view on the user's sheets) ≈ >90%/day, ~certain/week IF the synthetic proxy
  holds. Residual risk is CORRELATED proxy error (street-level dome templates vs elevated
  reality) — that is resolved only by the first real confirm, which this design hunts.
- Tests: ranked paging, budget cap, day reset, EOD demotion + alert-survivor all pass on a
  scratch DB with a stubbed mailer.

## v0.5 — Reliable zone-wide coverage: 484 cams, telemetered (2026-06-10)

User: "the entire site relies on… reliable coverage" + first digest was drowning in cars.
Measured before building: 2.7s CPU/clip (torch), one core pegged at 85%, cycles 3-11 min vs
TfL's 3-8 min refresh (~80% spine catch), 1,188 live candidates ≥0.81 in 24h (max 0.921, all
FPs), Waymo zone ≈ 484 available cams = 4x the spine load. Changes:

- **OpenVINO INT8 yolo11n** (`dataset/export_openvino.py` -> committed
  `collector/models/yolo11n_int8_openvino_model/`, 3.2MB), quantisation CALIBRATED on 300 of
  our own JamCam frames; + **vid_stride 3->5** (5 sampled fps; a passing car = 10-20 samples).
  VPS-measured: **2.49s -> 0.91s/clip (2.74x)** — and that was benched while the old loop ran.
  INT8 finds MORE car boxes than torch (49 vs 28 on the parity clip), so no funnel recall risk.
- **Zone-wide tiered watchlist** (`zone_watchlist()`): tier-1 = the 117-cam spine (processed
  first, NEVER dropped); tier-2 = every other available cam in the Waymo operating-zone box
  (lat 51.42-51.58, lon -0.36..-0.02) = **484 cams total** (was 117).
- **Poll/process split** (`watch_loop()` v2): one threaded conditional-GET pass over all 484
  cams every **POLL_EVERY=150s** (12 threads, pure I/O, no DB in workers). 150s < TfL's ~180s
  minimum refresh -> a camera can never publish two clips between polls — **the polling layer
  misses nothing**. Fresh clips queue per tier (FIFO); zone queue sheds OLDEST beyond
  MAX_BACKLOG=400, every drop counted. Single process, single DB writer, ~44MB peak queue.
- **Coverage telemetry**: per-cycle `cycles` row + timestamped log line (polled/fresh/processed/
  backlog/dropped/secs); per-cam refresh-period EMA (`per:<id>` kv) -> the daily digest now
  opens with an honest coverage line: processed / fetched / est. published.
- **Watchdog**: loop writes a heartbeat every iteration; `run_watch.sh` kills a HUNG loop
  (lock held, heartbeat >10 min stale) — flock alone only catches a dead one.
- **Thresholds re-anchored to LIVE data** (synthetic calibration was off: 0.83 bar -> 659
  digest/day): PROB_TH 0.83->**0.88** (~116/day spine, est ~300/day zone, score-sorted),
  NEAR_TH 0.81->**0.86**, ALERT_TH stays **0.93** (> live 24h max FP 0.921, n=1,188).
  685 pending sub-0.88 candidates demoted to 'near' (minable, 7-day prune).
- **Honest recall cost** (recall_eval at the new bar): planted-synthetic recall **8% per pass**
  @0.88 (was 54% @0.83) — the live FP tail overlaps the synthetic positive distribution; this
  is the frozen-embedding ceiling, not a regression. Offsets: ~4x more scoring opportunities
  zone-wide; the 0.86-0.88 near band still archives sub-bar passes for post-confirm mining;
  scorer upgrade comes from REAL positives (locked strategy), coverage was the binding ask.
- **What to watch**: dropped count in cycle lines (sustained drops -> shrink zone box or tune
  conf up); digest volume at 0.88 zone-wide (re-anchor if >>300/day); mem (two extra OpenVINO
  buffers); per-cam period EMAs converging (~1h) before the coverage % is trustworthy.

## v0.4 — Autonomous coverage: continuous spine loop (2026-06-09, evening)

User directive: the site finds Waymos itself — no human-triggered capture. Coverage was the
binding constraint (95 cams, 6-min ticks, 17h/day, ~70-80% of clip refreshes caught), so:

- **Depot->city SPINE**: watch expanded from 2 clusters (KX+PR, 95 cams) to **~117 cams** along
  the corridor every run must use — Park Royal depot -> A40/Westway -> Marylebone Rd ->
  Euston Rd/King's Cross (user-confirmed sighting hotspot), densest at KX (`SPINE`, `spine_focus()`).
- **Continuous ETag loop** (`--loop`, `watch_loop()`): replaces fixed sweeps. Each cycle
  conditional-GETs every spine cam (304 = zero download/decode) and processes ONLY fresh clips —
  no refresh missed, no wasted re-decode. Self-pacing under load (newest clip per cam wins).
  Per-camera DB commits (WAL writer no longer held for whole sweeps).
- **24/7**: `COLLECT_HOURS` (6,23) -> (0,24); Waymo tests at night and overnight CPU was idle.
  Digest stays 23:00; overnight candidates roll into next day's pages.
- **Supervision**: cron line unchanged (every 6 min) but `run_watch.sh` now starts the loop under
  `flock -n` + `nice -10` — alive = no-op, dead = restart within 6 min.
- **ALERT_TH 0.88 -> 0.93**: live white-car tails beat the 108-sample synthetic calibration
  (5 FPs >= 0.886 in the first 90 min, max 0.902, all user-rejected + banked). Digest is the
  primary channel until the scorer is re-seeded.
- Coverage arithmetic: ~117 cams x every refresh x 24h vs 95 x ~75% x 17h ≈ **2.3x more clips/day**,
  all of it on the corridor the fleet actually uses.
- **Next (recognition)**: harvest elevated-angle dome imagery -> re-seed centroid (the audit showed
  street-level templates are the wrong viewpoint for JamCams); then real positives -> Stage 2.

### v0.4.1 addendum — real-images-first support (same evening)

Strategy locked by user: capture first, train on REAL images only ("once we get the first one
we can perfect the dome"). Two pieces shipped in support:
- **Near-miss archive**: scores in [0.81, 0.83) stored silently (status='near', never emailed,
  7-day prune incl. jpgs; 'new'-row file cleanup fixed too — was orphaning forever). Purpose:
  once a real Waymo is confirmed anywhere, mine its sub-bar passes at other cameras
  (`status='near'` ± 45 min) as extra real training views. Near vehicles that later cross the
  bar are promoted into the digest.
- **`dataset/reseed_from_real.py`**: one command from first confirm -> pure-real (or blended
  <5 reals) centroid + recalibrated threshold quantiles + live artifact. Zero-delay
  "perfect the dome" the moment it happens.

## v0.3 — Surfacer recall fix: the funnel was blind (2026-06-09)

After 4 days of live watching with zero confirmed Waymos (user sees them daily on Euston Rd),
built a planted-positive recall test instead of waiting longer. Verdict: waiting was pointless.

- **Recall test** (`dataset/recall_eval.py`): synthetic Waymos (real dome pasted on real *white*
  JamCam hosts, copy-paste engine geometry) pushed through the EXACT live funnel. Pre-fix result:
  **end-to-end recall 2.5%** @ 0.82 digest bar, **0%** @ 0.90 alert bar; paired dome lift just
  **+0.016** — the score barely saw the dome. The 4 silent days fully explained: every reviewed
  candidate was white-car noise tail, and a real Waymo would have scored ~0.66.
- **Root cause:** domain mismatch. The centroid was built from tight close-up dome *photos*, but
  live scored the whole roof region (top 45% of car, 16% inset) — the MobileNet embedding was
  dominated by car/scene context, not the dome.
- **Fix** (validated honestly in `dataset/reseed_centroid_eval.py`, camera-grouped split):
  - **tight roof crop** — top 22% of bbox, 28% inset (`roof_crop()` is now the single source of
    truth in `live_capture.py`, imported by all eval scripts so geometry can't drift);
  - **centroid re-seeded from synthetic roof crops at live geometry** (`dataset/export_centroid.py`
    → `collector/dome_centroid_tight.json`, 108 pairs / 25 cameras, committed artifact);
  - pasted-vs-unpasted ROC-AUC **0.614 → 0.839**; recall **33% @ 1%** / **45% @ 5%** white-car
    pass-rate.
- **Thresholds recalibrated** (new score scale, incomparable to old): `PROB_TH` 0.82→**0.83**
  (white-car p95 = 0.831 → ~5% pass, digest volume ≈ unchanged); `ALERT_TH` 0.90→**0.88**
  (above all 108 known white-car scores, max 0.868).
- **Shipped-funnel regression** (in-sample): 54% of scored @ digest / 38% end-to-end — ~15× the
  blind funnel. Trust the split numbers (33–45%) as the honest estimate.
- Deployed to VPS; **114 old-scale pending candidates retired** (status→reject, files kept — old
  scores are incomparable). Verified: local 5-cam + VPS 8-cam sweeps clean under the cron flock.
- **What to watch:** digest volume (~5% of white tracks); `DEDUP_TH` 0.93 now compares tight-crop
  embeddings (less context — watch for distinct vehicles merging); **re-seed the centroid and
  re-tune both bars the moment the first real CCTV Waymo is confirmed.**

## v0.2 — High-quality dataset + GPU training recipe (2026-06-05)

- **Domes:** Commons (`Jaguar I-Pace (Waymo)`) + Bing crawl → auto-extracted roof crops,
  deduped → **39 diverse real dome templates** (from 8).
- **Backplates:** broadened to **4,734 frames / 92 cameras** (from 637/12).
- **Positives:** **400** dome composites across 67 source cameras, provenance-tracked (manifest).
- **Dataset:** 1-class `waymo`; in-domain real negatives (matched + plain traffic), ~4:1;
  **by-camera split** (10 feeds held out); 1,629 train / 335 val; QA'd.
- **Separability study:** dome separates easily from ordinary cars, but **Wayve is a genuine
  roof-rack confuser**; ≥90% dome-vs-Wayve can't be cheaply certified (frozen-probe-limited) →
  Wayve kept as hard-negative, ≥90% is a POST-TRAIN gate (`train/eval_wayve_gate.py`).
- **GPU recipe:** `train/train.py` (YOLO11s, imgsz1280, small-object-safe aug, ONNX export) +
  `train/RUNBOOK.md`. Validated end-to-end by the CPU smoke train (val P0.79 / mAP50 0.39).
- **Quality trim:** positives floored at host ≥44px (dome-resolvable); audit confirms 0 invalid
  labels + 0 train/val camera leakage. Final: 400 positives, 1,772 train / 194 val.
- Added `inferencePlan.md` — serving + self-hosted inference-cluster reference (rent-vs-buy, hardware).
- New scripts: dataset/{extract_domes,extract_roofs,crawl_images,wayve_fetch,build_dataset,
  separability,separability_eval,separability_scale_eval}.py; train/{train,eval_wayve_gate}.py.

## v0.1 — Data plane + synthetic-positive engine (2026-06-03)

First working slice. Detect-and-train infrastructure not built yet; this proves the two
hardest unknowns are tractable.

### What works (verified live with OpenCV, no GPU)
- **Collector** (`collector/data_plane.py`): enumerates all **882** TfL JamCams (779 available),
  conditional-GETs each camera's ~11s H.264 clip from S3 (ETag dedup), decodes with OpenCV,
  extracts frames at a configurable sample rate, records cameras/clips/frames in SQLite.
  - Baseline: 12 central cams → 12 clips, 637 frames in ~70s (single-threaded → needs
    parallelism at 779-cam scale).
- **Source imagery** (`dataset/fetch_sources.py`): 28 CC-licensed images from Wikimedia Commons —
  1 clean Waymo dome reference + many ordinary I-PACEs (negatives). Manifest records per-image licence.
- **Copy-paste engine** (`dataset/copy_paste.py`): `jamcam_degrade`, `composite`, `simulate_at_scale`.
- **Synthetic positives** (`dataset/make_synthetic.py`): detect cars (YOLO11n COCO) in real London
  backplates → paste a real Waymo dome on resolvable-size roofs (≥30px, aspect-ratio gated) →
  brightness-match + feather → re-degrade to JamCam JPEG → emit YOLO labels. **80 positives generated.**

### Baseline facts to watch
- TfL clip = 25fps / ~11s / 277 frames / 352×288, refreshed ~3–8 min. Full video sweep ≈ 216k
  frames/3min → sample every 5th (56f/clip) → 242fps required → needs 1 small GPU (Phase 5).
- **Dome resolvable only when host vehicle ≳45px tall** (`data/sources/dome_scale_test.jpg`).
- No off-the-shelf dataset/model fits (ego-viewpoint or non-commercial). Our JamCam frames + the
  copy-paste engine are the data strategy.

### Next
- Harvest more dome crops via yt-dlp/ffmpeg (YouTube/news) for angle variety.
- Generate matched negatives; assemble dataset.yaml (2 classes: waymo, wayve).
- Autolabel pipeline (YOLOE proposer + Claude dome/bar classifier) for real frames.
- Train WaymoNet v0 (YOLO11s + P2 head) on a rented 4090; eval by held-out clip; ship-gate P≥0.9.
- Two-stage inference runtime + Leaflet sighting feed + WhatsApp alerts.
