"""Opening, middlegame, endgame: Lichess's Divider (scalachess Divider.scala),
reimplemented from its rules so phases mean what they mean on Lichess.

The middlegame starts at the first position with ten or fewer minor and major
pieces, a thinned-out back rank, or enough mixing of the armies; the endgame at
six or fewer minor and major pieces. A move belongs to the phase of the
position it produces, counting plies from 1.
"""
from __future__ import annotations

import chess


def _majors_minors(b: chess.Board) -> int:
    return sum(1 for p in b.piece_map().values() if p.piece_type not in (chess.KING, chess.PAWN))


def _sparse(b: chess.Board) -> bool:
    white = sum(1 for sq, p in b.piece_map().items() if p.color and chess.square_rank(sq) == 0)
    black = sum(1 for sq, p in b.piece_map().items() if not p.color and chess.square_rank(sq) == 7)
    return white < 4 or black < 4


def _score(y: int, w: int, k: int) -> int:
    """How mixed one 2×2 window is: y is its upper rank (1-based), w and k the
    white and black pieces in it."""
    table = {
        (0, 1): 1 + y, (0, 2): 2 + (6 - y) if y < 6 else 0, (0, 3): 3 + (7 - y) if y < 7 else 0,
        (0, 4): 3 + (7 - y) if y < 7 else 0,
        (1, 0): 1 + (8 - y), (1, 1): 5 + abs(4 - y), (1, 2): 4 + (7 - y), (1, 3): 5 + (7 - y),
        (2, 0): 2 + (y - 2) if y > 2 else 0, (2, 1): 4 + (y - 1), (2, 2): 7,
        (3, 0): 3 + (y - 1) if y > 1 else 0, (3, 1): 5 + (y - 1),
        (4, 0): 3 + (y - 1) if y > 1 else 0,
    }
    return table.get((w, k), 0)


def _mixedness(b: chess.Board) -> int:
    total = 0
    for f in range(7):
        for r in range(7):
            w = k = 0
            for df in (0, 1):
                for dr in (0, 1):
                    p = b.piece_at(chess.square(f + df, r + dr))
                    if p:
                        w, k = (w + 1, k) if p.color else (w, k + 1)
            total += _score(r + 1, w, k)
    return total


def divide(moves: list[str], start: chess.Board | None = None):
    """Returns phase_of(i): the phase of the i-th move (0-based)."""
    b = start.copy() if start else chess.Board()
    boards = [b.copy()]
    for uci in moves:
        b.push_uci(uci)
        boards.append(b.copy())
    mid = next((i for i, x in enumerate(boards)
                if _majors_minors(x) <= 10 or _sparse(x) or _mixedness(x) > 150), None)
    end = next((i for i, x in enumerate(boards) if _majors_minors(x) <= 6), None) if mid is not None else None
    middle = mid if mid is not None and (end is None or mid < end) else None

    def phase_of(i: int) -> str:
        ply = i + 1
        if middle is None or ply < middle:
            return "opening"
        return "middlegame" if end is None or ply < end else "endgame"
    return phase_of
