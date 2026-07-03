# Chess Analysis — Changelog

## v2.6 — Serve the engine better (2026-07-03)

Efficiency release: same depths, dramatically less waiting. Zero new runtime
dependencies (three CDN dependencies removed).

### Hosting
- Now deployed to **https://chess.hjd.ai** (VPS nginx, `/var/www/chess`,
  `deploy/deploy.sh` via tailnet). GitHub Pages copy at
  hjd.ai/projects/chess/analysis.html keeps working as automatic fallback.
- nginx sends COOP/COEP (cross-origin isolation) → `SharedArrayBuffer` →
  **multi-threaded Stockfish**. Requires HTTPS (secure context): after the DNS
  A record exists, run `ssh root@vps-hel1 'certbot --nginx -d chess.hjd.ai'`.
- jQuery/chess.js/Chart.js vendored into `js/vendor/` — no CDNs.
- Engine wasm + vendor libs served immutable-cached and gzipped.

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
- depth-18 MultiPV-3 search: **1.7s** (start position)
- first analysis line after PGN load: **32ms**
- playback nav with prefetched cache: **9–26ms** to paint a depth-22 line
- accuracy suite: 5/5 pass

### What to watch
- Engine-ready time and time-to-first-arrow on real hardware over HTTPS.
- notes.txt's "engine dies ~5 moves in" — likely fixed by rAF coalescing;
  confirm it stays gone.
- If full-engine preload ever fails under load it silently falls back to lite
  for the graph — check console if graph seems weak.
