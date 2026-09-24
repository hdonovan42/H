# coach — Changelog

## v0.3 — Every cause opens: the idea, examples, puzzles (2026-09-24)

The owner asked for each row of "Where the winning chances go" to be
clickable, explaining the concept, with examples and interactive puzzles.

- **A topic per cause** (`#topic=<cause>`, reached from every bar and card).
  It has:
  - the idea, written for each cause;
  - what it looked like in your games, with the tactics or kinds named;
  - the habit and a target;
  - puzzles;
  - nine examples.
  The back button returns to the report where you left it.
- **Puzzles from your own games**, 675 of them, only where one move clearly
  stood out:
  - find your best move;
  - or, for the causes where you allowed something, take your opponent's side
    and find how to punish the move you played.
  They share one spaced-repetition record with the practice drill.
- **Lichess puzzles on the same theme**, from real games, fetched live from
  Lichess's public API. Its replies are played for you, and any mate counts.
- **Short of time** puzzles run against a 20-second clock.
- The page code is split into `ui.js`, `puzzle.js`, `topic.js` and `app.js`.
  One puzzle board serves the practice drill and every topic.
- Examples no longer carry a copy of their game's PGN: they look it up in the
  game list.


## v0.2 — The clock, in seconds (2026-09-24)

The owner pointed out that 20 seconds or less on the clock obviously costs
accuracy, and the report didn't show it. It had bucketed the clock by share of
the starting time (under 10% is 18 s in 3 + 2 but 6 s in 1-minute bullet) and
over every position, decided ones included. Measured in seconds, in positions
still open, blunders rise from 7% of moves with over 2 minutes to 29% with
20 seconds or less.

- Moves made with 20 seconds or less are no longer counted in the habits.
  They get their own section, "Short of time": what they gave away (12%), how
  games went once the clock got that low (39% scored against 67%), where the
  clock goes, and a lesson.
- The clock chart is in seconds left, over positions still open.
- Every example shows the time on the clock.

## v0.1 — chess.com games in, coaching out (2026-09-24)

The first version. Stockfish 19 analyses every move of the games since
2026-09-07, gives each costly move a cause, and ranks the causes by how much
winning chance they gave away, each with a lesson, examples from your own
games and drills. The report is `site/`; see the README for how it works and
how to move future games to another box.

- **Engine:** deterministic (1 thread, 1M nodes, MultiPV 2), with a second
  pass over costly moves for full-length lines and the opponent's threat.
- **Lichess's rules:** accuracy and move judgements are exact ports (24/24 and
  115/115 against lichess.org), and game phases and "only move" puzzles follow
  lila and lichess-puzzler.
- **Causes** come from the engine's counterfactuals (the best move, the second
  choice, a pass, the position before their last move); the board only names
  what happened. Four independent audits so far: 52%, 44%, 56%, then 62% of
  labels exactly right (82% in the right family).
- The report data (`site/insights.json`) and the games (`data/`) are not
  committed.
