"""Naming what happened, for a cause the engine's numbers have already decided
(insights.classify): the tactic a move carries out, the threat a player
ignored, what the opponent's reply did, or what a quiet move did to the
position. Geometry and piece definitions follow Lichess (lila, lichess-puzzler).
"""
from __future__ import annotations

import chess

VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
NAMES = {chess.PAWN: "pawn", chess.KNIGHT: "knight", chess.BISHOP: "bishop", chess.ROOK: "rook", chess.QUEEN: "queen", chess.KING: "king"}


def defended(board: chess.Board, square: int) -> bool:
    """Lichess's rule: guarded by its own side, counting a defender that stands
    behind an attacking bishop, rook or queen on the same line."""
    piece = board.piece_at(square)
    if board.attackers(piece.color, square):
        return True
    for a in board.attackers(not piece.color, square):
        if board.piece_type_at(a) in (chess.BISHOP, chess.ROOK, chess.QUEEN):
            b = board.copy(stack=False)
            b.remove_piece_at(a)
            if b.attackers(piece.color, square):
                return True
    return False


def hanging(board: chess.Board, square: int) -> bool:
    """Lichess's "bad spot": attacked, and either undefended or attackable by
    something cheaper. A king never counts as the cheaper attacker."""
    piece = board.piece_at(square)
    if piece is None or piece.piece_type == chess.KING:
        return False
    attackers = board.attackers(not piece.color, square)
    if not attackers:
        return False
    if not defended(board, square):
        return True
    return any(board.piece_type_at(a) != chess.KING and VALUE[board.piece_type_at(a)] < VALUE[piece.piece_type]
               for a in attackers)


ROYAL = 100  # a king outranks everything when comparing pin/skewer targets
DIRECTIONS = {
    chess.BISHOP: [(1, 1), (1, -1), (-1, 1), (-1, -1)],
    chess.ROOK: [(1, 0), (-1, 0), (0, 1), (0, -1)],
}
DIRECTIONS[chess.QUEEN] = DIRECTIONS[chess.BISHOP] + DIRECTIONS[chess.ROOK]


def _worth(piece: chess.Piece) -> int:
    return ROYAL if piece.piece_type == chess.KING else VALUE[piece.piece_type]


def _ray(square: int, df: int, dr: int):
    f, r = chess.square_file(square) + df, chess.square_rank(square) + dr
    while 0 <= f < 8 and 0 <= r < 8:
        yield chess.square(f, r)
        f, r = f + df, r + dr


def _first_two(board: chess.Board, square: int, df: int, dr: int) -> list[int]:
    """The first two occupied squares along a ray."""
    hits = []
    for sq in _ray(square, df, dr):
        if board.piece_at(sq):
            hits.append(sq)
            if len(hits) == 2:
                break
    return hits


def tactic(board: chess.Board, move: chess.Move) -> str | None:
    """The tactic `move` carries out for the side playing it, if any."""
    mover, piece = board.turn, board.piece_at(move.from_square)
    after = board.copy()
    after.push(move)
    if after.is_checkmate():
        return "mate"
    if after.is_check() and len(after.checkers()) > 1:
        return "double check"
    to = move.to_square
    moved = after.piece_at(to)  # a promoted piece is what counts
    # Fork (Lichess's rule): from a safe square, two non-pawn targets, each the
    # king, worth more than the forker, or undefended and not hitting back
    if moved.piece_type != chess.KING and not hanging(after, to):
        targets = [sq for sq in after.attacks(to)
                   if (t := after.piece_at(sq)) and t.color != mover and t.piece_type != chess.PAWN
                   and (_worth(t) > VALUE[moved.piece_type]
                        or (not defended(after, sq) and to not in after.attacks(sq)))]
        if len(targets) >= 2:
            return "fork"
    # Pin (to the king, of something worth pinning) or skewer, by the moved piece
    for df, dr in DIRECTIONS.get(moved.piece_type, []):
        hits = _first_two(after, to, df, dr)
        if len(hits) == 2 and all(after.piece_at(h).color != mover for h in hits):
            fp, bp = (after.piece_at(h) for h in hits)
            if bp.piece_type == chess.KING and fp.piece_type != chess.PAWN:
                return "pin"
            if _worth(fp) > _worth(bp) >= 3:
                return "skewer"
    # Discovered attack: moving away uncovers another piece's line onto a target
    for sq in after.pieces(chess.BISHOP, mover) | after.pieces(chess.ROOK, mover) | after.pieces(chess.QUEEN, mover):
        if sq == to:
            continue
        for df, dr in DIRECTIONS[after.piece_type_at(sq)]:
            path = list(_ray(sq, df, dr))
            if move.from_square not in path:
                continue
            hits = _first_two(after, sq, df, dr)
            if hits and path.index(hits[0]) > path.index(move.from_square):
                target = after.piece_at(hits[0])
                if target.color != mover and _worth(target) >= 3:
                    return "discovered attack"
    if board.is_capture(move) and board.piece_type_at(to) not in (None, chess.PAWN) and not defended(board, to):
        return "hanging piece"  # Lichess's sense: a free piece, not merely a good exchange
    return None


def mated_on_back_rank(board: chess.Board) -> bool:
    """Lichess's back-rank mate: the king mated on its home rank, the squares in
    front of it filled by its own unattacked pieces, a checker on that rank."""
    if not board.is_checkmate():
        return False
    them, king = board.turn, board.king(board.turn)
    home, ahead = (0, 1) if them == chess.WHITE else (7, -1)
    if chess.square_rank(king) != home:
        return False
    for df in (-1, 0, 1):
        f = chess.square_file(king) + df
        if 0 <= f < 8:
            sq = chess.square(f, home + ahead)
            p = board.piece_at(sq)
            if not p or p.color != them or board.attackers(not them, sq):
                return False
    return any(chess.square_rank(c) == home for c in board.checkers())


def first_move(board: chess.Board, line: list[str]) -> chess.Move | None:
    m = chess.Move.from_uci(line[0]) if line else None
    return m if m and m in board.legal_moves else None


def passed(board: chess.Board) -> chess.Board:
    """The position with the other side to move: what they would do if we passed."""
    b = board.copy(stack=False)
    b.turn, b.ep_square = not b.turn, None
    return chess.Board(b.fen())


def checks_given(board: chess.Board, line: list[str], by: bool, plies: int = 8) -> int:
    b, n = board.copy(), 0
    for uci in list(line)[:plies]:
        m = chess.Move.from_uci(uci)
        if m not in b.legal_moves:
            break
        mover = b.turn
        b.push(m)
        n += mover == by and b.is_check()
    return n


def _captured(after: chess.Board, m: chess.Move) -> bool:
    """Was `m`, the last move played on `after`, a capture?"""
    b = after.copy()
    b.pop()
    return b.is_capture(m)


def _taken(board: chess.Board, m: chess.Move) -> str:
    victim = board.piece_at(m.to_square)
    return NAMES[victim.piece_type] if victim else "pawn"  # en passant


def _material(board: chess.Board, colour: bool) -> int:
    """`colour`'s material less the other side's, in pawns."""
    return sum(VALUE[p.piece_type] * (1 if p.color == colour else -1) for p in board.piece_map().values())


def exchange(before: chess.Board, move: chess.Move, reply_line: list[str]) -> int:
    """What the player's material comes to over the move and the captures that
    follow on its square: below 0, they came out of the exchange behind."""
    b = _after(before, move)
    for uci in reply_line:
        m = chess.Move.from_uci(uci)
        if m not in b.legal_moves or m.to_square != move.to_square or not b.is_capture(m):
            break
        b.push(m)
    return _material(b, before.turn) - _material(before, before.turn)


def _net(board: chess.Board, line: list[str], side: bool, k: int) -> int:
    """`side`'s material gain over the line up to its capture at k, taking the
    capturer back if the next move recaptures on that square."""
    b = board.copy()
    for uci in line[:k + 1]:
        b.push_uci(uci)
    if k + 1 < len(line):
        back = chess.Move.from_uci(line[k + 1])
        if back in b.legal_moves and back.to_square == b.peek().to_square and b.is_capture(back):
            b.push(back)
    return _material(b, side) - _material(board, side)


def settled(board: chess.Board, line: list[str], side: bool) -> int:
    """`side`'s material gain over the whole line, read where it comes to rest:
    not straight after a capture that can still be taken back."""
    b, out, n = board.copy(), 0, 0
    for uci in line:
        m = chess.Move.from_uci(uci)
        if m not in b.legal_moves:
            break
        if not b.is_capture(m):
            out = _material(b, side) - _material(board, side)
        b.push(m)
        n += 1
    last = b.peek() if n else None
    if last and _captured(b, last) and any(b.is_capture(r) and r.to_square == last.to_square for r in b.legal_moves):
        return out
    return _material(b, side) - _material(board, side)


def reply_kind(before: chess.Board, move: chess.Move, reply_line: list[str]) -> tuple[str, str | None]:
    """For a move that made its own problem: how the opponent cashes in. The
    first of their captures in two moves that leaves them ahead names it, or a
    tactic on the way; either way the gain has to last to the end of the line.
    Returns (cause, detail); 'positional' when they win nothing for keeps."""
    them, line = not before.turn, [move.uci()] + list(reply_line)
    if settled(before, line, them) < 1:
        return "positional", None
    b, seen = _after(before, move), None
    for k in range(1, min(len(line), 5)):
        m = chess.Move.from_uci(line[k])
        if m not in b.legal_moves:
            break
        if b.turn == them:
            t = tactic(b, m)
            if b.is_capture(m) and k == 1 and m.to_square == move.to_square:
                if exchange(before, move, reply_line) < 0:
                    return ("traded_down" if before.is_capture(move) else "moved_into_attack"), f"your {_taken(b, m)}"
            elif b.is_capture(m) and _net(before, line, them, k) >= 1:  # counting the player's move too
                piece = f"your {_taken(b, m)}"
                if k == 1 and before.piece_type_at(move.from_square) != chess.KING:
                    guarded = m.to_square in before.attacks(move.from_square) and m.to_square not in b.attacks(move.to_square)
                    opened = move.from_square in chess.SquareSet(chess.between(m.from_square, m.to_square))
                    if guarded or opened:
                        return "left_undefended", piece
                return "allowed_tactic", seen or (t if t and t != "hanging piece" else piece)
            if t and t != "hanging piece":
                seen = seen or t  # a fork, say, that wins on the next move
        b.push(m)
    return ("allowed_tactic", seen) if seen else ("positional", None)


def sharp(board: chess.Board, move: chess.Move) -> bool:
    """A capture, check or promotion, or a move that carries out a tactic."""
    return bool(board.is_capture(move) or move.promotion or board.gives_check(move) or tactic(board, move))


def forcing(board: chess.Board, line: list[str], score: dict | None) -> bool:
    """Is the line a real threat for the side to move on `board`: a mate, a
    blow within its first two moves (a tactic, a capture that wins, a
    promotion), or two checks?"""
    side = board.turn
    if score and "mate" in score and (score["mate"] > 0) == (side == chess.WHITE):
        return True
    return _first_blow(board, line, side, 4) is not None or checks_given(board, line, side, 4) >= 2


def _first_blow(board: chess.Board, line: list[str], side: bool, plies: int = 6) -> str | None:
    """Along a line: the first tactic `side` carries out, else the first piece
    of the other side's it takes and keeps (an even trade isn't a blow), else a
    promotion."""
    b, line = board.copy(), list(line)
    for k, uci in enumerate(line[:plies]):
        m = chess.Move.from_uci(uci)
        if m not in b.legal_moves:
            return None
        if b.turn == side:
            t = tactic(b, m)
            if t and t != "hanging piece":
                return t
            if b.is_capture(m) and not b.is_en_passant(m) and _net(board, line, side, k) >= 1:
                return f"{_taken(b, m)} on {chess.square_name(m.to_square)}"
            if m.promotion:
                return "a promotion"
        b.push(m)
    return None


def threat_detail(before: chess.Board, pass_line: list[str], pass_eval: dict | None) -> str:
    """What the opponent threatened: what they'd do if the player passed."""
    me = before.turn
    if pass_eval and "mate" in pass_eval and (pass_eval["mate"] < 0) == (me == chess.WHITE):
        return "a mate threat"
    blow = _first_blow(passed(before), pass_line, not me)
    if blow is None:
        return "an attack on your king" if checks_given(passed(before), pass_line, not me, 4) >= 2 else "their threat"
    return blow if " on " not in blow else f"your {blow}"


def shot_detail(before: chess.Board, best_line: list[str], last: chess.Move | None) -> str:
    """The winning idea the player missed: the best move's tactic, or what the
    best line wins first. `last` is the opponent's last move if it captured."""
    m = first_move(before, best_line)
    if m is None:
        return "a strong move"
    if before.is_capture(m) and last is not None and last.to_square == m.to_square:
        return "the recapture"
    if before.is_capture(m) and not before.is_en_passant(m) and not defended(before, m.to_square):
        return f"a free {_taken(before, m)}"
    blow = _first_blow(before, best_line, before.turn)
    if blow and " on " in blow:
        return f"winning the {blow}"
    return blow or character(before, m)


def character(board: chess.Board, move: chess.Move) -> str:
    """What a move with no tactic in it does: checks, trades, or threatens a
    piece (one worth more than the mover, or left undefended)."""
    if board.gives_check(move):
        return "a check"
    if board.is_capture(move):
        return "an exchange"
    after = _after(board, move)
    mover = VALUE[after.piece_type_at(move.to_square)]
    targets = [after.piece_at(sq) for sq in after.attacks(move.to_square)
               if (p := after.piece_at(sq)) and p.color != board.turn and p.piece_type != chess.KING
               and (VALUE[p.piece_type] > mover or (p.piece_type != chess.PAWN and not defended(after, sq)))]
    if targets:
        return f"a threat to the {NAMES[max(targets, key=lambda p: VALUE[p.piece_type]).piece_type]}"
    return "a quiet move"


def feature(before: chess.Board, move: chess.Move, reply_line: list[str] = (), phase: str | None = None) -> str:
    """What a costly quiet move did to the position."""
    piece = before.piece_type_at(move.from_square)
    if checks_given(_after(before, move), reply_line, not before.turn) >= 2:
        return "an attack on your king"
    if weakens_king(before, move):
        return "a pawn in front of your king"
    if piece == chess.KING and not before.is_castling(move) and before.pieces(chess.QUEEN, not before.turn) and phase != "endgame":
        return "a king walk with queens on"
    if phase == "endgame":
        return "endgame technique"
    if phase == "opening":
        return "opening play"
    return "a middlegame plan"


def _after(board: chess.Board, move: chess.Move) -> chess.Board:
    b = board.copy()
    b.push(move)
    return b


def weakens_king(before: chess.Board, move: chess.Move) -> bool:
    """A shield pawn pushed from in front of a castled king: the king on a wing
    on its first two ranks, the pawn on its second or third rank, on the king's
    file or next to it, and not taking anything."""
    if before.piece_type_at(move.from_square) != chess.PAWN or before.is_capture(move):
        return False
    king = before.king(before.turn)
    rank = lambda sq: chess.square_rank(sq) if before.turn == chess.WHITE else 7 - chess.square_rank(sq)
    kf, pf = chess.square_file(king), chess.square_file(move.from_square)
    return rank(king) <= 1 and rank(move.from_square) <= 2 and kf not in (3, 4) and pf not in (3, 4) and abs(kf - pf) <= 1
