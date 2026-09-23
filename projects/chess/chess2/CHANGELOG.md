# chess2 — Changelog

## v1.0 — A clean rewrite of the analysis board (2026-09-23)

chess2 takes over the board's original address,
https://hjd.ai/projects/chess/analysis.html. The first version stays, untouched,
at `analysisRetro.html`. chess2 is the same tool rewritten from nothing,
keeping what the first one learned and none of its machinery: 1,018 lines of
JavaScript against 3,023, no jQuery, no chessboard.js, no Chart.js, and more
than it did before.

### Why
Pieces only registered when dropped near the centre of a square. The legacy page
zoomed the whole UI with `transform: scale()`, and chessboard.js tested drops
against its unscaled 62 px squares while reading their positions from the
scaled screen. At the usual 140% auto-zoom, only the top-left half of each square
accepted a drop; below 100%, drops landed on the neighbouring square. Measured
in headless Chrome before anything was written.

### What
- **Board** (`js/board.js`): its own. Pieces sit in board fractions and every
  pointer event is resolved against the board's on-screen rectangle when it
  happens, so no zoom, scroll, transform or flip can misplace a drop. Drag or
  click-click, by mouse, touch or pen (pointer events; the page doesn't scroll
  under a finger, and a second finger can't hijack a drag). No animation:
  pieces land instantly. Promotion offers all four pieces (Esc dismisses);
  SVG pieces and arrows stay sharp at any size. The page is sized in real
  pixels: one column on a phone, board as large as the window allows, the side
  panel exactly level with the board.
- **Engine** (`js/engine.js`): Stockfish 19 (Stockfish.js 19.0.0, released
  2026-09-15). One class, one rule: one search at a time, and a new search
  stops the old one and waits for its `bestmove` before sending anything, which
  is the only order UCI can match replies in. No pool, no staged boot, no
  timeouts, no watchdog: a slow download is just slow, and a crashed worker is
  terminated, settles whatever was waiting on it and is replaced. A 1.6 MB lite
  build draws arrows within a second; the full 94 MB build takes over once it's
  loaded. Searches get the moves that led to the position, as Lichess sends
  them, so repetitions count.
- **Review** (`js/main.js`): a second full engine. A 20k-node pass draws the
  whole curve at once; a 600k-node pass then runs last move to first so each
  search inherits the hash table of the positions after it. Finished reviews
  are kept in `localStorage`: reopening a game is instant and its verdicts
  don't change (threaded search varies slightly run to run, enough to flip a
  badge that sits on a threshold).
- **Lichess-exact maths** (`js/lichess.js`, 78 lines): accuracy and now also
  the judgements. Legacy chess invented its own badges ("brilliant" for any 1.5
  pawn gain); chess2 uses lila's Advice rules: win-chance drops of 0.1/0.2/0.3,
  the mate-sequence rules, no verdict when the engine's own move was played,
  none for the mating move. Two details a port from memory gets wrong, found by
  reading lila's source: Advice uses uncapped centipawns, and the harmonic mean
  treats any move accuracy below 1 as 1.
- **Graph** (`js/graph.js`, 40 lines of SVG): winning chances, as Lichess plots
  them, so +3 reads as a real advantage and mates saturate (fixes the note
  "±3 graphs as a tiny advantage").
- **Eval bar**: the score at its foot, as before, dark on white and light on
  black whichever way up the board is.
- **Also:** a move tree with side lines (Esc returns to the game), engine lines
  in SAN (tap one to play it), Lichess tablebase verdicts at seven pieces or
  fewer, FEN input (illegal positions refused, since Stockfish aborts on them),
  the first game of a multi-game PGN, openings from Lichess or chess.com
  headers, player strips with accuracy, error counts and material, and the
  board remembering which side you play once you flip to it (a long-standing
  note). The Lichess extension (`chess/extension/`) already targets
  `analysis.html`, so it opens chess2 unchanged.

### Where it lives
`projects/chess/chess2/`, with `projects/chess/analysis.html` as its page. It
started beside `chess/` and had to move in: the coi-serviceworker that grants
threads covers only its own folder, and Chrome matches each engine worker to a
service worker by the worker's own address, so engines loaded from
`/projects/chess2/` got no isolation headers and never started. Caught by the
browser suite and, independently, by the code review.

### Independent review
A fresh agent reviewed every file and found 22 issues. Fixed: an empty paste
wiping the game; list taps firing when a finger started a scroll; FENs with the
side not to move in check (Stockfish aborts); drags that ignored pointer ids;
unnormalised FEN whitespace flipping the side to move; a promotion landing on
whichever position was showing when the chooser closed; crashed workers never
terminated; a slow Lichess fetch overwriting a newer load; "0%" accuracy for a
side with no moves; drag leftovers after a position change; no game history
sent to the engine; the reviewer engine loaded before any game; no-op
navigation restarting the search; unchecked URL parameters; orientation
priority; Space on a focused button; unlabelled promotion buttons; low-contrast
text. Left as noted: tablebase misses stay cached for the session.

### Verified
- `tests/lichess.test.js`: 12 lichess.org-analysed games. Accuracy matches
  lichess.org **exactly** after rounding for all 24 player scores; all 115
  judgements match.
- `tests/browser.test.js`, 7 tests in headless Chrome against the whole site
  served as GitHub Pages serves it, at `chess/analysis.html`: boots and hands
  over to threaded Stockfish 19; drops at the corners and centre of e3 and e4
  land correctly on a desktop, a small window, under CSS zoom 1.25, under a CSS
  transform, and by touch on a phone; click-click moves; promotion and
  dismissing it; a full review with navigation, side lines, graph seeking and
  the kept review; the single-threaded fallback with no service worker; a
  Lichess link. Against EricRosen–kyrgyznur (lichess.org/pb4aOR73) chess2
  scores 94 / 80 where lichess.org says 93 / 82.
- The owner's chess.com games (read-only copy of the VPS store, not
  committed): all 198 PGNs load, move counts matching the ingest pipeline. 50 of
  them reviewed end to end in headless Chrome: 3,468 positions, no errors,
  median 19 s a game, all 15 mate and stalemate finishes handled. Against
  chess.com's own accuracy on the 44 it scored: correlation 0.80, chess2 three
  points lower on average (Lichess's formula is the stricter one).
