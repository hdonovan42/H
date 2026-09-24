# chess2 — Changelog

## v1.1 — Set up a position (2026-09-24)

A way to put a position on the board without playing up to it or pasting a
FEN. `e`, or the Set up button beside the paste box, opens an editor on the
position on the board.

- **The palette.** It takes the side panel's place, each colour's six pieces
  on its own side of the board. The rows sit exactly level with the board's top
  and bottom edges (measured), and the board doesn't move.
- **Placing, three ways.**
  - Drag a piece in from the palette.
  - Pick one by clicking it or typing its FEN letter (`K Q R B N P` / `k q r b n p`),
    then click or sweep across squares. Pawns on c3 and d4 are two clicks, and
    clicking a square with the picked piece takes it off.
  - On the board, drag pieces anywhere; drag them off, or right-click, to
    remove them.
- **Keys.** `s` start position, `c` empty board (all but the kings), `x`
  eraser. `f` still flips, Enter analyses, Esc puts a picked piece down and
  then cancels.
- **Rules the editor keeps.** The kings are always there, one each: a king
  placed moves that side's king, and right-click, the eraser, dragging off and
  dropping a piece on one all leave it be. Pawns never go on the first or last
  rank.
- **Side to move and castling.** Each is one click. A castling right can only
  be ticked with the king and rook at home.
- **Legality.** Analyse waits for a legal position and says what's wrong
  ("White is in check with Black to move.").
- **The FEN** underneath updates live, takes a pasted one, and copies with the
  button at its right-hand end.
- **Analyse** starts from the position, and `#fen=<fen>` opens it again. Opening
  and closing the editor without changes keeps the game you were in.
- **Board hooks.** `board.js` gains two small hooks: `squareAt(x, y)` for drops
  from the palette, and `onDropOff` for pieces dragged off the board.
- **Tests.** Two new browser tests. One covers the palette, picking, sweeping,
  removal, the kings staying put, castling, an illegal position, copying the
  FEN, flipping, analysis and reopening the `#fen=` address; the other a drag
  from the palette by touch.
  - The address is reopened in a fresh page: puppeteer's `reload()` sometimes
    comes back without the service worker, and without the hash.
  - A timeout now reports the board and the address too.
- **The key line** under the panel is shortened to fit its width: it had run
  past the edge.

Files: `js/editor.js` (new), `js/main.js`, `js/board.js`, `style.css`,
`../analysis.html`, `tests/browser.test.js`.


## v1.0.2 — A board other pages can use, and links to a moment (2026-09-24)

- **`#pgn=<pgn>&ply=<n>&color=black`** opens a game at a given move, from Black's
  side if asked. The coach report links every example this way. A hash never
  reaches a server, so the game stays in the link. `js/main.js`.
- **`board.css`** holds the board's own styles, split out of `style.css`, so
  another page (the coach report) can show chess2's board without the
  analysis page's layout. `analysis.html` loads both.
- Arrows take an optional class (`[from, to, class]`), so a page can colour
  its own (the report draws the better move green, the game's move red).

Files: `js/main.js`, `js/board.js`, `board.css`, `style.css`, `../analysis.html`.

## v1.0.1 — Eval bar, engine-off header, a board that never shifts (2026-09-23)

- **Eval bar fills completely once a game is decided.** A forced mate, or
  ±10.00 and beyond, now shows as 100% / 0% instead of Lichess's capped 97.5%,
  which left a sliver of the losing colour on a mate. The curve below that is
  unchanged, and accuracy and badges keep the capped formula (they must, to
  match lichess.org). `js/main.js`: `barWin()`.
- **"Engine off" sits at the start of the header**, not a third of the way in:
  the empty score no longer reserves its width. The header keeps its height,
  so toggling doesn't nudge the move list (41 px on and off, measured).
- **The board can never move with the engine's text.** A flaky drop test (2 of
  6 runs, CSS zoom only) turned out to be the board shifting sideways between
  engine updates: when the page overflowed, flexbox shrank the side panel to
  its content. Both columns are now fixed (`flex: none`) and centring is
  `safe`; the board holds still (measured) and the drop test passes every run.
  Normal window sizes never overflowed, so users weren't hit.
- Tests: a timeout now reports what the page showed (engine line, review
  progress, errors); the single-threaded fallback test gets a generous ceiling,
  since one thread is slow when other engines hold every core.

Files: `js/main.js`, `style.css`, `tests/browser.test.js`.

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
