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
