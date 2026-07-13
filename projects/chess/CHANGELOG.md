# Chess Analysis — Changelog

## v2.9.1 — Fix graph crash introduced by v2.9 (2026-07-13)

User-reported: every graph run died with the "Graph analysis failed. Please
refresh the page and try again." popup. Root cause: v2.9's dead-code removal
deleted `updateIncrementalAccuracy()` (a one-line accuracy-cache invalidator)
but left both call sites in the graph commit path — a `ReferenceError` on
every eval commit. When the first commit came synchronously (cached/forced
position — position 0 nearly always is), the error rejected the pass promise
→ popup; async commits from `bestmove` threw uncaught and stalled workers →
frozen graph. Reproduced headlessly on v2.9, gone after the fix.

- Inlined the invalidation (`AppState.cachedAccuracy = null`) at both commit
  sites. Still needed despite the eval-count check: polish overwrites sketch
  evals without changing the defined count, so a mid-run accuracy would
  otherwise stay stale.
- **New: `tests/graph-smoke.js`** — end-to-end headless graph run (GitHub
  Pages-style static serve + coi-serviceworker isolation, real engine pool,
  full sketch+polish pass, asserts zero popups/page errors and a fully
  populated eval history). This is the test v2.9 lacked: the accuracy suite
  runs `script.js` in a vm sandbox and never executes the graph path.
- Verified: pre-fix code reproduces the exact popup + `ReferenceError`
  (graph dead at 1/25 evals); fixed code completes 25/25 with accuracy
  rendered; `tests/accuracy-test.js` still 12/12.

## v2.9 — Accuracy standardised on Lichess, exactly (2026-07-04)

User-reported: accuracy "wildly off" vs reputable sites. **Confirmed and
root-caused.** The old aggregation deviated from Lichess's published
algorithm in three ways (per-colour instead of combined volatility windows;
weighting window averages instead of individual moves; harmonic mean over
window averages instead of raw move accuracies). The harmonic deviation
smoothed blunders out of the score — on identical evals, a game Lichess
scores 57/65 came out 85/85. Mean error 3.3 points, max 28, worst exactly
in blunder-heavy games; clean games agreed, which is why casual checks on
good games looked fine.

- Replaced with an **exact port of lila's `AccuracyPercent.gameAccuracy`**
  (win% ±1000cp clamp, +1 uncertainty bonus, 100-on-improvement, per-move
  volatility weights over the combined win% sequence with first-window
  duplication, mean of weighted + harmonic means).
- **Verified: ±0.5 of lichess.org's official numbers on 12 real
  server-analysed games** (mean error 0.32), in-browser against the shipped
  code, not a copy.
- chess.com was the user's first preference but CAPS2 is proprietary and
  unpublished — it cannot be standardised against, only curve-fit
  approximated. Lichess is open source and exactly reproducible; note that
  chess.com numbers will still read differently (their scale runs higher).
- `tests/accuracy-test.js` rewritten: loads `script.js` itself (vm sandbox,
  single source of truth) and regresses against the 12 official fixtures
  (`tests/lichess-accuracy-fixtures.json`). Old synthetic-bot test retired.
- Removed dead code: `computeWeightedAccuracy`, `calculateMoveAccuracy`,
  `cpLossToAccuracy`, `evalToWinProbability`, `getAccuracyRating`,
  `_accuracySums`.
- Remaining caveat: displayed accuracy for a given game still differs
  slightly from lichess.org's because our evals come from our own engine
  pass (depth 18–20) rather than fishnet's — the formula is now exact, the
  eval source is ours.

## v2.8 — Graph analysis 10×+: parallel worker pool (2026-07-04)

The graph fill was the slow part — one worker searching every position
sequentially at fixed depth 22 (~minutes per game). Replaced with a pool
architecture: **~9–12× measured** on a 56-position game (189.7s median
baseline → 18–23s across runs on a noisy bench box; probe-normalised
~9.5–10.4×). The interim config with adaptive decided-stretch budgets hit
10.3× median but was reverted for badge fidelity — see below; the shipped
uniform config trades ~1.1× for faithful classifications. Curve visible
in ~2.5s (was: minutes).

- **Pool of 4 full-net workers** (2 threads, 32MB hash each): separate
  positions parallelise perfectly; SMP inside one search scales sublinearly.
- **Node-budgeted searches** (`go depth 22 nodes N`) instead of bare depth —
  near-constant wall-clock per position.
- **One task queue, no barrier**: strided sketch tasks (12k nodes,
  0,4,8,…,1,5,9,… so spanGaps draws a full-width coarse curve in ~2s)
  followed by in-order polish tasks (600k nodes ≈ d18-20, full net);
  workers flow straight from sketching into polishing.
- **Uniform polish budget everywhere.** A reduced budget for decided
  stretches was built, measured, and REVERTED before shipping: it bought
  ~1.1× at the cost of systematically softening blunder badges the deep
  reference shows. Residual badge flips on moves that sit exactly on a
  class threshold (e.g. a 1.5-pawn delta at +5.5 eval) are intrinsic SMP
  noise — verified present in repeated baseline runs too, and a cache-depth
  diagnostic confirmed polish genuinely runs everywhere (d18-21, no
  sketch leakage). Win%-based classification would saturate these out —
  future work.
- Forced moves carry the previous eval (old-path behaviour restored);
  tablebase and evalCache short-circuits; polish PVs prefetched into
  evalCache for instant playback; pool kept warm between games,
  hard-reset only when a new game loads mid-run.
- Engine identity finding: blunder markers lost with the lite net did NOT
  return at 2× lite nodes but returned immediately with the full net —
  net identity beats depth for eval agreement. Full findings in memory
  (`stockfish-batch-eval-findings`).

Verified: nav still 0 chart updates (5.4ms avg), dot overlay pixel-correct,
badges patch, accuracy suite 5/5, no page errors. 10-move test game:
174s → 3.3s end-to-end.

## v2.7 — Graph drawing rework (2026-07-03)

Playback no longer pays for the eval graph.

- **Current-position dot moved off Chart.js** onto its own overlay canvas
  (`#graph-dot-overlay`, created in `initEvalChart`). Navigation now draws one
  circle from cached pixel coords — measured **0 chart updates across 20 nav
  steps** (was one full chart rebuild per keypress). Nav sync cost ~7ms avg.
- **Throttled analysis-pass repaints**: during the graph pass the chart
  redraws at most every 250ms (`GRAPH_REDRAW_MS`), with a final full render on
  completion. Notation classification badges are patched per move in place —
  no more full notation HTML rebuild per eval.
- **In-place dataset mutation**: chart arrays are allocated once per game
  length and mutated per redraw — no per-redraw allocation churn.
- resetBoard now keeps an idle graph worker warm (only kills a mid-run one).
- Verified: dot pixel-tested at cached coords (#FF5722), badges patch,
  accuracy suite 5/5, no page errors.

### What to watch
- Dot position after browser zoom changes without a window resize (cache
  refreshes on resize/redraw; a stale dot would self-correct on next data
  change or resize).

## v2.6 — Serve the engine better (2026-07-03)

Efficiency release: same depths, dramatically less waiting. One new vendored
file (`coi-serviceworker.min.js`); three CDN dependencies removed.

### Hosting
- Stays at the original URL: **https://hjd.ai/projects/chess/analysis.html**
  (GitHub Pages). No new domain.
- `coi-serviceworker.min.js` (vendored, MIT, ~2KB, must sit next to
  analysis.html and load as the first script) injects the COOP/COEP headers
  GitHub Pages can't send → `crossOriginIsolated` → `SharedArrayBuffer` →
  **multi-threaded Stockfish**. First visit does one automatic reload;
  after that isolation is immediate. Browsers without service-worker/SAB
  support silently get the single-threaded fallback.
- jQuery/chess.js/Chart.js vendored into `js/vendor/` — no CDNs.
- (A chess.hjd.ai VPS vhost was built and verified during this work, then
  reverted at the user's request — original domain preferred. nginx conf
  and deploy script existed briefly; see git history if ever wanted again.)

### Engine serving
- **Threaded SF 17.1 builds** (lite + full, from stockfish npm 17.1.0) selected
  at runtime via `crossOriginIsolated`; single-threaded SF 17 otherwise.
  Threads = cores−2 (max 8), Hash 256MB (128MB single).
- **evalCache** (FEN-keyed, 2000 entries): finished searches are banked;
  revisiting a position paints arrows/eval instantly with no re-search.
- **Graph prefetch**: the depth-22 graph pass banks its best line per position,
  so after the graph finishes the whole mainline plays back instantly.
- **Persistent graph worker**: survives between games (no WASM/NNUE re-init,
  warm transposition table).
- Live display updates rAF-coalesced (was: full DOM/canvas repaint per UCI info
  line); 10ms/5ms scheduling hops removed.

### Baseline (headless smoke test, 12-core machine, 8 threads)
- isolation via service worker: ~1.1s after first visit (incl. auto-reload);
  immediate on later visits
- threaded engine ready: ~2.4s from first visit
- depth-18 MultiPV-3 search: **1.7–2.3s**
- first analysis line after PGN load: **32ms**
- playback nav with prefetched cache: **9–26ms** to paint a depth-22 line
- accuracy suite: 5/5 pass

### What to watch
- Engine-ready time and time-to-first-arrow on real hardware at hjd.ai.
- notes.txt's "engine dies ~5 moves in" — likely fixed by rAF coalescing;
  confirm it stays gone.
- If full-engine preload ever fails under load it silently falls back to lite
  for the graph — check console if graph seems weak.
- Safari: coi-serviceworker support is decent on recent versions; if isolation
  fails there the app quietly runs single-threaded — that's expected, not a bug.
