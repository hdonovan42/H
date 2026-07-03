# Engine Efficiency: Serve Stockfish Better (no strength tuned down)

Goal: pukka playback — arrows and eval land instantly while stepping through a game.
Approach: more compute per second (threads), never re-compute what's already known
(cache/prefetch), stop wasting main-thread and worker start-up time.
Net dependencies: **zero added** (three CDN deps removed; no coi-serviceworker —
VPS nginx sets real COOP/COEP headers).

## Phase A — Hosting groundwork (VPS)
- [x] Vendor CDN libs into `js/vendor/` (jquery 3.6.0, chess.js 0.10.3, chart.js 4.4.7)
- [x] Threaded builds added from stockfish npm 17.1.0 (SF 17.1, content-hashed filenames):
      `stockfish-17.1-lite-51f59da.{js,wasm}`, `stockfish-17.1-8e4d048.js` + 6 part wasms
- [x] `ENGINES` selects threaded vs single at runtime via `self.crossOriginIsolated`
- [x] nginx vhost `chess.hjd.ai` (COOP/COEP, wasm gzip, immutable caching) — deployed + reloaded
- [ ] **DNS: A record `chess.hjd.ai` → 89.167.4.126 (USER — same panel as axiom.hjd.ai)**
- [ ] **TLS after DNS: `ssh root@vps-hel1 'certbot --nginx -d chess.hjd.ai'`**
      (threading REQUIRES https — crossOriginIsolated only exists in secure contexts)
- [x] `deploy/deploy.sh` (rsync via tailnet) — first deploy done (~134MB)
- [x] Extension `ANALYSIS_URL` → chess.hjd.ai (user: reload unpacked extension)

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
- [x] Headless-browser smoke test vs deployed VPS (tailnet + host-mapping):
      crossOriginIsolated=true, 8 threads, d18 MultiPV-3 in 1.7s, first line 32ms,
      graph 21/21 @ d22, evalCache=21, nav 9–26ms serving d22 lines instantly, accuracy OK
- [x] Fallback test (no headers, python http.server): single build chosen, d18 works, 0 errors
- [ ] Manual browser pass on https://chess.hjd.ai after DNS+TLS (arrows/sidelines/flip/
      toggle/switch/promotion/checkmate PGNs) — needs user's browser

## Review
Implemented exactly as planned, zero new dependencies (3 CDN deps removed).
One addition surfaced during verification: **threading needs a secure context**,
so certbot isn't optional — until TLS is issued, chess.hjd.ai serves the
single-threaded fallback (still fully functional).
Transient full-engine part-fetch failures were observed once under saturated
CPU in headless WSL; preload succeeded cleanly on re-test and degrades to lite
if it ever recurs. Watch: engine-ready time, time-to-first-arrow, and whether
the ~5-moves-in engine death from notes.txt is gone (rAF coalescing + no timer
hops are the likely fix).
