# coach — Changelog

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
