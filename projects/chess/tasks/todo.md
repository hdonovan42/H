# Engine Efficiency: Serve Stockfish Better (no strength tuned down)

Goal: pukka playback — arrows and eval land instantly while stepping through a game.
Approach: more compute per second (threads), never re-compute what's already known
(cache/prefetch), stop wasting main-thread and worker start-up time.
Hosting: ORIGINAL URL kept (hjd.ai/projects/chess/analysis.html, GitHub Pages);
cross-origin isolation comes from the vendored coi-serviceworker shim.

## Phase A — Groundwork
- [x] Vendor CDN libs into `js/vendor/` (jquery 3.6.0, chess.js 0.10.3, chart.js 4.4.7)
- [x] Threaded builds added from stockfish npm 17.1.0 (SF 17.1, content-hashed filenames):
      `stockfish-17.1-lite-51f59da.{js,wasm}`, `stockfish-17.1-8e4d048.js` + 6 part wasms
- [x] `ENGINES` selects threaded vs single at runtime via `self.crossOriginIsolated`
- [x] `coi-serviceworker.min.js` vendored NEXT TO analysis.html (SW scope), first script
      in head — injects COOP/COEP on GitHub Pages; one auto-reload on first visit
- [x] ~~chess.hjd.ai VPS vhost~~ — built, verified, then REVERTED (user keeps original
      domain); VPS vhost + web root torn down, deploy/ removed (in git history)
- [x] Extension `ANALYSIS_URL` — back to hjd.ai/projects/chess (user: reload extension)

## Phase B — Multi-threading
- [x] `Threads = clamp(cores−2, 1, 8)`, `Hash 256` when isolated (1 thread / 128MB fallback)
- [x] Applied via `sendEngineOptions()` to live, preloaded and graph workers

## Phase C — Serve from work already done
- [x] `evalCache` Map (FEN → results, cap 2000): full hit ≥d18 + 3 lines → paint, skip search;
      partial hit → paint instantly, engine refines
- [x] Graph pass banks its depth-22 PV1 into evalCache → whole mainline pre-armed
- [x] Stale-search protection: cache serve never adopts activeAnalysisId, late messages rejected

## Phase D — Main-thread hygiene
- [x] `scheduleLiveDisplayUpdate()` rAF-coalesces info-line repaints; bestmove flushes direct

## Phase E — Persistent graph worker
- [x] Worker survives between runs (`graphWorkerIdle`); TT kept warm; respawn on error/timeout

## Phase F — Small stuff
- [x] Dead `ANALYSIS_DEBOUNCE_TIME` deleted; 10ms/5ms setTimeout hops removed

## Verification
- [x] `node tests/accuracy-test.js` — 5/5 bots pass
- [x] GitHub-Pages simulation (static server, NO headers) + coi-serviceworker:
      isolated ~1.1s after first visit (one auto-reload), SW-controlled, 8 threads,
      engine ready 2.4s, d18 MultiPV-3 in 2.3s, second visit isolated instantly, 0 errors
- [x] No-SW fallback path verified earlier: single build chosen, d18 works, 0 errors
- [x] evalCache + graph prefetch verified: 21/21 positions banked, nav paints d22 in 9–26ms
- [ ] Manual browser pass on https://hjd.ai/projects/chess/analysis.html AFTER PUSH
      (push = deploy on GitHub Pages) — arrows/sidelines/flip/toggle/switch/promotion

## Review
Implemented as planned with one reversal: the VPS-header approach was built and
verified first, then the user clarified the original domain must stay — swapped
to the coi-serviceworker shim (vendored, ~2KB), VPS vhost torn down. Lesson
recorded in tasks/lessons.md ("leave X as is" = the pre-existing state).
Watch: engine-ready time on real hardware; whether the ~5-moves-in engine death
from notes.txt is gone; Safari quietly falling back to single-threaded is expected.

## Graph rework A–C (2026-07-03, follow-up)
- [x] A: current-position dot on `#graph-dot-overlay` canvas; `_applyNavigation()`
      calls `drawGraphDot()` only — 0 chart updates across 20 nav steps (verified)
- [x] B: 250ms throttle on analysis-pass chart repaints + per-move notation badge
      patching (`patchNotationClassification`); full render once at completion
- [x] C: chart arrays allocated once per game length, mutated in place
- [x] Bonus: resetBoard keeps idle graph worker warm
- [x] Verified: dot pixel test (#FF5722 at cached coords), accuracy 5/5, 0 errors
- [ ] D (optional, not built): replace Chart.js with hand-rolled canvas sparkline

## Graph analysis 10× (2026-07-04, "iterate until x10")
- [x] Parallel pool (4 × full-net × 2 threads) + node budgets replace sequential d22
- [x] Unified task queue: strided 12k sketch → in-order 600k polish, no barrier
- [x] Adaptive decided-stretch budget (150k when pos+both neighbours ≥ |5|)
- [x] Forced-move carry, tablebase + evalCache short-circuits, warm pool
- [x] MEASURED: 10.3× median raw, 10.4× probe-normalised, 11.9× worst-pair,
      13.6× best-pair (56-pos game, 3 baselines vs 3 runs); curve at ~2.5s
- [x] Iterations v1→v11 documented in memory: stockfish-batch-eval-findings
- [x] Regressions: nav 0 chart updates, dot pixel test, badges, accuracy 5/5
- [x] REVERTED decided-stretch budget before ship (user call: badge fidelity > arbitrary
      10× line) — final uniform 600k ≈ 9-12× depending on run; residual marker flips
      proven threshold-noise via cache-depth diagnostic (polish runs everywhere, d18-21)

## v2.9.1 hotfix — graph crash (2026-07-13)
- [x] User report: "Graph analysis failed. Please refresh the page" popup on graph runs
- [x] Root cause: v2.9 deleted updateIncrementalAccuracy() but left 2 call sites in the
      graph commit path → ReferenceError on every eval commit (sync commit → popup;
      async commit → uncaught throw, stalled workers, frozen graph)
- [x] Fix: inlined AppState.cachedAccuracy = null at both commit sites (still required —
      polish overwrites sketch evals without changing the defined-eval count)
- [x] tests/graph-smoke.js added: real headless in-browser graph pass (the coverage gap
      that let v2.9 ship this)
- [x] Verified: bug reproduced on pre-fix copy (popup + ReferenceError, 1/25 evals);
      fixed tree completes 25/25, accuracy renders, accuracy suite 12/12, smoke PASS

## Accuracy standardisation (2026-07-04)
- [x] Investigated user report "accuracy wildly off" — CONFIRMED: old aggregation
      deviated from Lichess spec 3 ways; worst case 28 points (57/65 → 85/85)
- [x] chess.com CAPS2 ruled out (proprietary, unpublished) — standardised on Lichess
- [x] Exact port of lila AccuracyPercent.gameAccuracy; verified ±0.5 on 12 real
      server-analysed games (in-browser, shipped code)
- [x] tests/accuracy-test.js rewritten: loads script.js itself + 12 official fixtures

## v2.9.2 — graph pool boot + lifecycle (2026-08-29)
User report: "analysis page has become slow and I just got a 'Graph analysis
failed. Please refresh the page' error." Two symptoms, TWO DIFFERENT causes.
The popup's real error had to be captured in headless Chrome, because the broad
catch in runGraphPasses turns every distinct failure into the same message:
`Error: All graph pool workers failed to initialise`, preceded by 4× "Graph
pool worker init timeout" at exactly 20001ms.

- [x] ROOT CAUSE (crash): all 4 pool workers booted at once shared ONE deadline
      starting at t=0 while the ~75MB net was still arriving. Below ~30-40Mbps
      the download outlasted the 20s timeout and all four failed together.
      Cold cache, isolated, single plain PGN load: HEAD popped at 30/20/10Mbps
      and cleared 40Mbps with only 3.1s of margin.
- [x] FIX: ensureGraphPool() boots in two stages — one worker alone (120s
      budget) does the download, then the rest in parallel off the warm cache
      (~1.3s each). MEASURED: 4/4 at every link 200 → 5Mbps, no popup.
      Wall clock +1-2s on fast links, inside run-to-run noise (unthrottled the
      staged boot actually came out 3.6s faster).
      NOTE 1: raising the timeout alone was tried FIRST and REJECTED — still
      4/4 timeouts at 40Mbps, just at 45001ms. It moves the cliff, not the
      cause. Don't "fix" this again by growing the timeout.
      NOTE 2: staging does NOT work by moving fewer bytes. With normal cache
      headers (GitHub Pages sends ETag/Last-Modified/Cache-Control) the browser
      already coalesces the four fetches — 75.2MB either way, HEAD included. It
      works by giving the one unavoidable download a deadline it can meet.
      Don't "simplify" back to a parallel boot on the theory bytes are equal.
- [x] Stage 2's budget is derived from stage 1's MEASURED duration, capped at
      120s. A fast stage 1 means caching works (keep the 45s cap); a slow one
      means the cache is cold or disabled (hard reload) and each stage-2 worker
      must re-download. Without this a no-cache load left 3 of 4 workers timing
      out and the pass limped on a one-worker pool: 113s vs ~40s, SILENTLY.
      MEASURED 40Mbps no-cache: stage1 31580ms -> stage2 budget 63160 -> 46716,
      46727, 47153ms, 4/4, 94443ms total. Note those stage-2 workers were
      missing the old fixed 45s cap by only 1.7-2.2s.
- [x] A budget is a CEILING, not a wait — a worker that loads in 1.3s is
      unaffected by a large one. So when stage 1 FAILS, stage 2 now gets the
      full 120s cap, NOT the 45s floor. The first attempt at this had the rule
      inverted: a stage-1 timeout is the strongest signal stage 2 needs MORE
      room, and giving it the floor guaranteed failure with caching off
      (measured 10Mbps no-cache: 5 workers, all timed out, popup at +172s).
- [x] Last-resort stage: if the pool is still EMPTY after stage 2, one final
      solo attempt at 240s. Parallel attempts contend for the same bandwidth,
      so a lone worker with the whole pipe can succeed where four cannot. One
      engine draws the graph slowly; zero is the popup. Never runs on the happy
      path.
- [x] ROOT CAUSE (slow): cancelGraphRun() only terminated workers when
      _graphRunActive was true, but runGraphPasses sets that flag BEFORE
      awaiting ensureGraphPool — so the terminate loop ran over a still-EMPTY
      graphPool and killed nothing. A cancel landing DURING init orphaned four
      full-net engines, alive and unreachable for the life of the tab. Paste
      auto-loads, so this needs no unusual user behaviour.
      MEASURED, 15 reloads churned at 800ms (faster than the ~1.3s init, which
      is what opens the window): HEAD grew to 86 live workers / 14811MB peak
      RSS; FIX stays flat at 24 / 4651MB. Worker constructions 65 → 20.
      (At 4s churn neither version leaks — the window is only open during init.)
- [x] FIX: _graphWorkers tracks every worker from birth; _graphPoolGen retires
      an init that lands after a cancel; _graphPoolPromise shares one in-flight
      init; _graphPoolAborts settles cancelled inits at once (a terminated
      worker never answers 'isready', so they otherwise sat pending for the
      full timeout).
- [x] ensureGraphPool accepted ANY non-empty pool, so a pool degraded by worker
      deaths was never topped up — one survivor did all the work for the rest
      of the session. Now tops up to GRAPH_POOL_SIZE, reusing warm survivors.
- [x] HANG: a worker dying mid-pass ended its pump chain without resolving; if
      it was the last, runGraphPass never settled and the graph froze
      half-drawn with NO error. A stale per-search onerror also stayed armed on
      idle workers → double-decrement of `active` (negative → unreachable
      `=== 0` → hang; or early zero → partial graph published as complete).
      FIX: one decrement per task (taskDone guard), idle-death handler that
      drops the worker without decrementing, maybeFinish resolves when no live
      worker remains, plus a 90s stall watchdog.
- [x] evalCache evicted a bystander on every sketch→polish upgrade (evicted
      before deleting the key it was about to reuse). One-line reorder.
- [x] Tablebase misses weren't cached — every rate-limited 429 was re-requested
      by both the sketch and polish task for the same FEN, forever.

## Verification
- [x] tests/pool-lifecycle-test.js ADDED — drives the pool with a scripted fake
      Worker in a vm sandbox; deterministic, no browser. 11/11 pass, and FAILS
      on pre-fix code for each bug (leak 8 alive vs 4, no top-up 1/4, never
      settles, 4-workers-at-once). Closes the gap graph-smoke.js can't reach:
      it loads one game once on a warm pool with no worker failures.
- [x] tests/accuracy-test.js — 12/12, mean abs error 0.32, unchanged
- [x] Headless bandwidth sweep 200 → 5Mbps, cold cache, isolated: 4/4, no popup
- [x] Churn test at 800ms: worker count flat, RSS 14.8GB → 4.7GB peak
- [x] No-cache (hard reload) 40Mbps: 4/4, 94443ms (was 1/4, 113385ms)
- [x] No-cache 200Mbps: 4/4, 37265ms (was 41455ms). 20Mbps no-cache: 4/4.
- [x] Cached path unchanged: 40Mbps stage2 1276/1349/1414ms; 5Mbps stage1
      times out then stage2 comes up ~5s each off the partial cache, 4/4
- [ ] Re-run 10Mbps no-cache against the last-resort solo stage

## KNOWN LIMITATION (not a bug — physics of a ~79MB net)
With HTTP caching UNAVAILABLE (hard reload / devtools "Disable cache") AND a
link under ~20Mbps, first load is minutes: the pool must pull ~79MB per worker
with no reuse. Timeout tuning only chooses between "slow" and "error"; it
cannot make the bytes arrive faster. The last-resort solo stage is there to
land on "slow" rather than "error". The real lever is engine SIZE — the lite
net is ~7MB vs ~79MB — but GRAPH_POOL_ENGINE is deliberately 'full' so graph
evals match live analysis, and a previous change was reverted specifically to
protect badge fidelity. Switching the pool to lite on slow links is a product
decision about badge drift, NOT something to change silently.
- [ ] Manual browser pass on https://hjd.ai/projects/chess/analysis.html AFTER
      PUSH (push = deploy on GitHub Pages)

## Review
Two lessons worth keeping. First, the popup and the slowness had DIFFERENT root
causes, and the first plausible story (OOM caused by the leak) was WRONG — the
leak is real and large, but the crash was a plain deadline problem. Only
capturing the actual console.error behind the generic popup separated them.
Second, measurement harnesses lie: an early sweep blamed 120-200Mbps because
the test server omitted cache headers that GitHub Pages actually sends, which
suppressed Chrome's fetch coalescing and tripled the bytes. Re-running against
production-like headers moved the real cliff to 30-40Mbps and invalidated the
"staging saves bandwidth" explanation. Always give the static test server the
same caching headers as the host.
Follow-up worth doing: narrow that catch in runGraphPasses, or at least surface
err.message, so the next one of these doesn't need a multi-agent investigation.
