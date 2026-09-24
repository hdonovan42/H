"""Lichess's analysis maths, the Python twin of chess2's js/lichess.js: accuracy
(lila AccuracyPercent) and move judgements (lila Advice). Both are checked
against lichess.org's own analysis of the same 12 games (tests/test_lichess.py).

An eval is {"cp": n} or {"mate": n}, White's point of view; mate is never 0.
"""
from __future__ import annotations

import math

CEILING = 1000
INITIAL = {"cp": 15}


def _cp(e: dict) -> int:
    return (CEILING if e["mate"] > 0 else -CEILING) if "mate" in e else e["cp"]


def _chances(cp: float) -> float:  # [-1, 1]; uncapped here, as Advice uses it
    return max(-1.0, min(1.0, 2 / (1 + math.exp(-0.00368208 * cp)) - 1))


def win_percent(e: dict) -> float:  # [0, 100], White's point of view
    return 50 + 50 * _chances(max(-CEILING, min(CEILING, _cp(e))))


def _move_accuracy(before: float, after: float) -> float:
    if after >= before:
        return 100.0
    raw = 103.1668100711649 * math.exp(-0.04354415386753951 * (before - after)) - 3.166924740191411
    return max(0.0, min(100.0, raw + 1))


def _stdev(xs: list[float]) -> float:
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))


def accuracy(evals: list[dict], white_starts: bool = True) -> dict | None:
    """{white, black} accuracy from the evals after each move (unrounded)."""
    if not evals:
        return None
    wins = [win_percent(e) for e in [INITIAL, *evals]]
    size = max(2, min(8, len(evals) // 10))
    windows = [wins[:size]] * (min(size, len(wins)) - 2) + [wins[i:i + size] for i in range(len(wins) - size + 1)]
    weights = [max(0.5, min(12.0, _stdev(w))) for w in windows]
    by = {"white": [], "black": []}
    for i in range(min(len(wins) - 1, len(weights))):
        white = (i % 2 == 0) == white_starts
        prev, nxt = wins[i], wins[i + 1]
        by["white" if white else "black"].append(
            (_move_accuracy(prev, nxt) if white else _move_accuracy(nxt, prev), weights[i]))

    def colour(moves):
        if not moves:
            return None
        weighted = sum(a * w for a, w in moves) / sum(w for _, w in moves)
        harmonic = len(moves) / sum(1 / max(1.0, a) for a, _ in moves)
        return (weighted + harmonic) / 2
    return {c: colour(m) for c, m in by.items()}


def judge(prev: dict, nxt: dict, white_moved: bool) -> str | None:
    """'inaccuracy' | 'mistake' | 'blunder' | None. lila only asks when the move
    wasn't the engine's best; the caller checks that."""
    pov = 1 if white_moved else -1
    if "cp" in prev and "cp" in nxt:
        drop = (_chances(prev["cp"]) - _chances(nxt["cp"])) * pov
        return "blunder" if drop >= 0.3 else "mistake" if drop >= 0.2 else "inaccuracy" if drop >= 0.1 else None
    pm = prev["mate"] * pov if "mate" in prev else None
    nm = nxt["mate"] * pov if "mate" in nxt else None
    if pm is None and nm is not None and nm < 0:  # walked into a forced mate
        cp = prev["cp"] * pov
        return "inaccuracy" if cp < -999 else "mistake" if cp < -700 else "blunder"
    if pm is not None and pm > 0 and (nm is None or nm < 0):  # let a forced mate slip
        cp = nxt["cp"] * pov if nm is None else 0
        return "inaccuracy" if cp > 999 else "mistake" if cp > 700 else "blunder"
    return None
