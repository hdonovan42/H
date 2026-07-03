# Chess Analysis — Changelog

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
