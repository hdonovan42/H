# chess2

A chess analysis board that runs entirely in the browser: Stockfish 19 on the
position in front of you, and a full game review (accuracy, inaccuracies,
mistakes and blunders) computed exactly the way lichess.org computes them.

**Live:** https://hjd.ai/projects/chess/analysis.html, the board's original
address (GitHub Pages; pushing to `main` deploys). The first version lives on,
untouched, at `analysisRetro.html` beside it.

**Where things are.** The page is `projects/chess/analysis.html`, a shell that
loads everything from this folder. chess2 sits inside `projects/chess/` rather than
beside it because the service worker that gives Stockfish its threads
(`chess/coi-serviceworker.min.js`) only covers that folder, and Chrome matches
each engine worker to a service worker by the worker's own address.

## Use

Paste a PGN, a FEN or a Lichess game link into the box. `?game=<lichess id>`
(and `&color=black`) opens a Lichess game directly; the Lichess extension in
`chess/extension/` adds a button that does exactly that.

Drag pieces or click, click; pieces move instantly, with no animation. Keys:
← → through the moves, ↑ ↓ to the start or end, `f` flip, `t` engine on/off,
space plays the engine's move, Esc returns to the game from a side line, `r`
resets. Press or drag on the graph to seek. Flip the board to your side once
and your games open that way up from then on.

## How it works

| File | Job |
|---|---|
| `js/main.js` | The move tree, live analysis, game review, drawing |
| `js/board.js` | The board: pointer input resolved against its on-screen rectangle, so zoom, scroll and transforms can't misplace a drop |
| `js/engine.js` | One Stockfish worker over UCI: one search at a time, no timeouts |
| `js/lichess.js` | lila's accuracy and move-judgement maths, ported line for line |
| `js/graph.js` | The evaluation graph, in winning chances as Lichess draws it |

- **Engines.** A 1.6 MB lite build answers within a second; the full 94 MB
  build takes over once loaded. Without cross-origin isolation (Firefox private
  windows have no service workers) the single-threaded lite build does
  everything. Every search is sent the moves that led to its position, as
  Lichess does, so repetitions count.
- **Review.** A second full engine runs a quick pass over the game (the whole
  curve appears in about a second), then a deep pass of 600k nodes per position
  from the last move back to the first, so each search inherits the hash table
  of what follows. Finished reviews are kept in `localStorage`, so reopening a
  game is instant and gives the same verdicts every time.
- **Lichess-exact.** Accuracy and judgements use lila's formulas, including
  cp 15 for the start, no verdict when the engine's own move was played, and
  none for the mating move. The evals are this engine's, not lichess.org's,
  so a game's numbers land close to Lichess's rather than identical.

## Tests

```sh
npm test                            # lichess.js against lichess.org's analysis of 12 games
npm install --no-package-lock       # once: puppeteer-core (uses the system Chrome, or CHROME_BIN)
npm run test:browser                # end to end in headless Chrome; NETWORK=1 adds a Lichess fetch
```

The browser suite serves the whole site the way GitHub Pages does (no
isolation headers, real cache headers), opens `chess/analysis.html`, and drops
pieces at the corners of squares at several window sizes, with CSS zoom, under
a CSS transform and by touch.

## Licences

Stockfish.js 19 (GPLv3, `vendor/stockfish/COPYING.txt`), chess.js 1.4.0
(BSD-2-Clause, `vendor/chess.js.LICENSE`), cburnett pieces by Colin M.L. Burnett
(GPLv2+), coi-serviceworker (MIT).
