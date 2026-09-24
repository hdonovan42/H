# coach — chess.com games in, analysis and coaching out

Brief (2026-09-24): find the pitfalls, mistakes and missed opportunities that recur
in the owner's games, and give a strong, actionable lesson for each. A system:
chess.com games in, computer analysis and insights out.

Constraints from the owner:
- Dataset = the ingest store's range: games since 2026-09-07 17:13 UTC. Older games
  sit behind a year's gap and aren't current play; the set grows naturally.
- Backlog computed on this desktop. Future games: another box (homebox/VPS, owner
  to find), so the worker must be self-contained and schedulable. VPS untouched.

## Plan
- [x] Size the data: 3,318 games since 2021 exist; in scope 208 (172 blitz, 36 bullet)
- [x] Native Stockfish 19 (official x86-64 build; avx-vnni picked) + python-chess venv
- [x] games.py: chess.com → one JSON per game (ETag-cached; no VPS)
- [x] engine.py: deterministic analysis (1 thread, 1M nodes, MultiPV 2, fresh hash
      per game, last-to-first), niced, parallel, atomic writes, resumable
- [x] lichess.py: Python twin of chess2's lichess.js; 24/24 + 115/115 vs lichess.org
- [x] Research (agent): lichess-puzzler theme rules, Divider, puzzle "only move" test,
      training URLs; reimplemented from rules (sources are AGPL, repo is MIT)
- [x] phases.py (Divider), motifs.py (why a move cost), insights.py (causes, cost
      shares, punish rate, clock, phases, conversion, openings, repeats, puzzles)
- [x] lessons.py: a lesson per cause (what, why, habit, drills, target)
- [x] site/: report page, reusing chess2's board; examples deep-link into chess2
      (`analysis.html#pgn=…&ply=…`); own-position drills with spaced repetition
- [x] Plumbing: setup.sh (any Linux box, x86-64 or arm64), `update --publish`, lock
- [x] Full backlog analysed (209 games), report reviewed end to end (headless Chrome)
- [x] Independent audits of cause labels, re-judged with the engine on fresh samples:
      1: 52% · 2: 44% (led to the counterfactual classifier) · 3: 56% strict / 80% family
      · 4: 62% strict / 82% family
- [ ] Audit 4 fixes: no `positional` while material is at stake (best line wins more
      for keeps); threat test over 6 plies and material; in-check threats;
      left_undefended at the square that falls; perpetual needs a repetition;
      promotion-led mates; net-gain naming. Then audit 5.
- [x] Clock: judge time pressure in seconds left, not share of the base; keep
      time-scramble moves apart from the habits (owner, 2026-09-24: "≤20 seconds")
- [x] Topics (owner, 2026-09-24): each cause clickable, with the idea, examples,
      and puzzles (own positions: find / refute; Lichess by theme); browser-tested
      (wrong move refused, right move solved, a 5-move Lichess line, the timer, back)
- [ ] Owner: publish the report data on hjd.ai, or keep it local?

## Found along the way
- The laptop CPU (i7-1365U) throttles to ~2 GHz on all cores: ~2.5 games/min with
  10 workers, ~80 min for the backlog. A future box: ~3 CPU-min per game.
- Summing win% drops overstates "points lost" when the opponent errs back (the same
  missed fork counted three moves running), so causes are shown as shares.
- Reading engine lines only until the first quiet move hid tactics that start quietly;
  lines are now read to their last resting point.
