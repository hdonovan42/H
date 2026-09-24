# coach

chess.com games in; computer analysis and coaching out. Every move of every
game is searched by Stockfish 19, judged by Lichess's rules, and each costly
move is given a cause (a threat you didn't answer, a piece left hanging, a fork
you walked into, a win you didn't take…). Causes are ranked by how much of your
winning chances they gave away, and each comes with a lesson, examples from
your own games, drills, and a target.

The report is a static page, `site/index.html`, reading `site/insights.json`.
Examples open in the analysis board (`../analysis.html`) at the moment in
question, and your own positions become spaced-repetition drills on the page.

Each place the winning chances go opens as a topic of its own
(`#topic=<cause>`). A topic has the idea behind it, what it looked like in
your games, the habit, puzzles and examples. The puzzles come from two
sources:

- **Your own positions**, only where one move beat every other by 10% of win
  chance, so there's one fair answer. Some ask for your best move; others show
  the move you played and ask you to take your opponent's side and find the
  punishment.
- **Lichess puzzles** on the same theme, from real games, fetched live from
  its public API.

`site/`: `app.js` is the report, `topic.js` a topic, `puzzle.js` the puzzle
board, and `ui.js` what they share.

## Dataset

Games since the ingest pipeline's first game, 2026-09-07 17:13 UTC (`SINCE` in
`games.py`): earlier games sit behind a year's gap and aren't current play.
Fetched straight from chess.com's public API; the VPS isn't involved.

## Commands

```sh
./setup.sh                        # venv + python-chess + Stockfish 19 for this CPU; runs the tests
.venv/bin/python coach.py sync    # new games from chess.com (a quiet run is one cached request)
.venv/bin/python coach.py analyse # Stockfish over games not yet analysed, newest first
.venv/bin/python coach.py report  # rebuild site/insights.json
.venv/bin/python coach.py update  # all three; --publish also commits and pushes the report
.venv/bin/python coach.py status
```

`COACH_DATA` moves the data folder; `COACH_STOCKFISH` points at another binary.

## How it works

| File | Job |
|---|---|
| `games.py` | chess.com → one JSON file per game in `data/games/` |
| `engine.py` | Stockfish 19 on every position: one thread, 1M nodes, best two moves |
| `lichess.py` | Lichess's accuracy and move judgements (the twin of chess2's `lichess.js`) |
| `phases.py` | Lichess's opening / middlegame / endgame divider |
| `motifs.py` | Why a move cost: plays the engine's lines out and names the tactic |
| `insights.py` | Per-move records, causes, ranking, time and phase pictures |
| `lessons.py` | The coaching text for each cause |
| `report.py` | `site/insights.json` |

### How a costly move gets its cause

A move is costly when it gives away 10% or more of the win chance (lila's
"mistake" bar). The cause comes from the engine's own counterfactuals, all as
win% for the player. They are: the best move, the move played, the engine's
second choice, a pass (the opponent to move again) and the position before
the opponent's last move. The rules, in order:

1. **Mates.** It walked into a forced mate (`allowed_mate`), or had one and
   played something else (`missed_mate`).
2. **Their blunder, not punished.** Their last move handed over 15% or more,
   and this one gave it back without sinking lower (`missed_win`;
   `missed_defence` when the best move only drew level).
3. **A perpetual allowed.** From a winning position into a drawn one, with
   their checks to follow.
4. **An ignored threat.** No better than passing, against a threat that other
   moves met and that has teeth: a mate, a tactic, material won for keeps, or
   two checks.
5. **About as good as the second choice.** The best move stood out by 25%, or
   by 15% when it's a capture, check or tactic: a missed shot. Otherwise the
   move is `positional`.
6. **Worse than the second choice.** First, if their reply is the threat they
   already had, the threat was ignored or only half met. Otherwise the reply
   is read for what it wins for keeps, net of recaptures. Walking into a
   losing exchange is `moved_into_attack`; starting one is `traded_down`.
   Taking the guard off a piece is `left_undefended`. A fork, pin, skewer or
   discovered attack is `allowed_tactic`. Anything else is `positional`, named
   by kind: king safety, a king walk, endgame technique, opening play or a
   middlegame plan.

Costly moves made with 20 seconds or less on the clock (`SCRAMBLE`) are
counted apart, as time trouble: at that speed any habit breaks down. The
habits are ranked on the moves made with time to think, and the clock gets its
own section, with blunder rates by seconds left, in positions still open.

The board is only used for naming. An independent audit, where an agent
re-judged random samples with the engine, drove four rounds of these rules;
the latest accuracy is in `tasks/todo.md`.

- **Deterministic.** One thread, a fixed node count, a fresh hash per game and a
  fixed order: any machine with the same binary and settings produces the same
  numbers, so the work can move between machines without changing a verdict.
- **Low priority.** Analysis runs at `nice 19`; the machine stays usable.
- **Lichess's definitions.** Accuracy and judgements are exact ports (tested
  against lichess.org on 12 games); forks, pins, back-rank mates, game phases
  and "only move" puzzles follow lila and lichess-puzzler's rules, reimplemented.

## Moving future games to another box

The backlog was computed on the desktop. To have a homebox or VPS analyse new
games from then on:

1. On the box: clone the repo, then `projects/chess/coach/setup.sh --cron`.
2. Hand over the analysed backlog once: `rsync -a <desktop>:<repo>/projects/chess/coach/data/ data/`
   (or skip this and let the box recompute it: the results are identical).
3. Add the printed crontab line. Every 30 minutes it syncs, analyses new games
   with 2 workers at low priority, rebuilds the report and, with `--publish`,
   commits and pushes `site/insights.json` (it needs push access to the repo).
   The report is gitignored until it's decided to publish it; until then
   `--publish` stops with git's "paths are ignored" error, so leave it off.

A game takes about 3 minutes of one core, so a dozen games a day is about 40
minutes of CPU. The games and their analysis stay on the box; only the derived
report is committed.

## Tests

```sh
.venv/bin/python tests/test_lichess.py   # accuracy and judgements vs lichess.org, 12 games
.venv/bin/python tests/test_motifs.py    # the tagger on textbook positions
```
