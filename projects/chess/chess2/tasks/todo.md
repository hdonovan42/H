# chess2 — rewrite of the analysis board

Brief (2026-09-23): fork `chess` into a new project, keep the old one as legacy,
rewrite it the way it should be written. Minimalism and sanity are the value.
Trigger: drops only registered near a square's centre (CSS transform zoom vs
chessboard.js's unscaled hit-test; measured before starting).

## Plan
- [x] Read all of legacy (script.js, CHANGELOG, tasks, notes, tests, extension)
- [x] Engines: benchmark Stockfish 17.1 against Stockfish.js 19 (published
      2026-09-15) headlessly. 19 works cleanly; its full build is ~10% slower
      per node and stronger per node. Take the 19 family: full, lite, lite-single
- [x] lila's source for accuracy and Advice, fetched (not recalled): harmonic
      floor at 1, uncapped cp in Advice, best-move gate, mated position dropped
- [x] `js/lichess.js` + test first: fixtures fetched from lichess.org's API
      (12 games, evals, judgements, official accuracy)
- [x] `js/engine.js`: one worker, UCI strictly sequential, no timeouts
- [x] `js/board.js`: rect-based hit-testing, drag + click-click, touch, promotion
- [x] `js/graph.js`, `js/main.js`, `index.html`, `style.css`
- [x] `tests/browser.test.js`: GitHub Pages-style server; drop hit-test across
      sizes, CSS zoom, transform and touch; click-click; promotion; full review
- [x] Owner's chess.com games (VPS store, read-only copy, not committed): all 198 parse
- [x] 50 of them reviewed in headless Chrome: 3,468 positions, 0 errors, median 19 s/game;
      vs chess.com accuracy r = 0.80, chess2 3 points lower on average
- [x] README; CHANGELOG (the legacy extension already targets analysis.html)
- [x] Independent review by a fresh agent: 22 findings, all bugs fixed (see CHANGELOG)
- [x] Owner: chess2 takes `chess/analysis.html`; legacy renamed `chess/analysisRetro.html`
      (legacy graph-smoke test repointed; everything linking to analysis.html now gets chess2)
- [x] chess2 moved into `projects/chess/chess2/`: the service worker only covers `chess/`
- [x] Owner: side panel level with the board, top and bottom; no "White"/"Black" labels;
      no move animation; eval score back at the foot of the bar with the readable-colour rule
- [ ] Manual pass in a real browser AFTER PUSH (push = deploy)

## Found along the way
- Stockfish prints `info … pv ` with an EMPTY pv when stopped before depth 1;
  parsing it produced NaN arrows. Rejected in `parseInfo`.
- An `<input>` deletes line breaks from typed or dropped text, fusing
  "d4⏎9. Na4" into "d49. Na4". The load box is a one-row `<textarea>`.
- Moving the page out of the engine's folder silently broke threading: coi-serviceworker
  covers only its own folder, and Chrome matches a dedicated worker to a service worker by
  the WORKER's URL. Isolated page + engine outside the scope = workers refused, engine
  stuck on "Loading". Only an end-to-end test at the real address catches it.
- Threaded review results vary run to run (same game, two runs: one badge
  flipped between ? and ??). Kept reviews make a game's verdicts stable.

## Open
- Deterministic review would need single-threaded searches per position; too
  slow with one engine, too much memory as a pool of 94 MB engines. Revisit if
  badge stability across *different* browsers ever matters.
- chess.com accuracy (CAPS2) is unpublished; chess2 stays on Lichess's.
