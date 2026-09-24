"""From analysed games to insights: every one of the player's moves becomes a
record, costly moves get a cause, and causes are ranked by what they cost.

Cost is measured in game points. Win% (Lichess's curve) is an expected score,
so the win% a move gives away, summed and divided by 100, is the number of
points it cost: "ignored threats cost you 6.1 points over 208 games" means
about six games' worth of results.
"""
from __future__ import annotations

import math
import statistics
from collections import Counter, defaultdict

import chess

import lichess
import motifs
import phases

# Causes, most specific first; each costly move gets exactly one
CAUSES = ["allowed_mate", "ignored_threat", "moved_into_attack", "left_undefended", "traded_down",
          "allowed_tactic", "missed_mate", "missed_win", "missed_defence", "positional"]
COSTLY = 10  # win% lost that makes a move worth explaining (lila's "mistake")
# Seconds on the clock at or under which a move is a scramble: at that speed any
# habit breaks down, so these moves are counted apart from the habits
SCRAMBLE = 20


def base_seconds(time_control: str) -> tuple[int, int]:
    base, _, inc = time_control.partition("+")
    return int(base), int(inc or 0)


def moves_of(game: dict) -> list[dict]:
    """A record for every move the player made in an analysed game."""
    a = game["analysis"]
    evals, best, pv, second = a["evals"], a["best"], a["pv"], a["second"]
    me_white = game["me"] == "white"
    base, inc = base_seconds(game["time_control"])
    board, out, took = chess.Board(), [], False
    phase_of = phases.divide(game["moves"])
    for i, uci in enumerate(game["moves"]):
        move = chess.Move.from_uci(uci)
        mine = (i % 2 == 0) == me_white
        if mine and evals[i] is not None:  # evals[i + 1] is None only after the player's own mating move
            before = lichess.INITIAL if i == 0 else evals[i]
            after = evals[i + 1]
            pov = 1 if me_white else -1
            w0 = lichess.win_percent(before) if pov == 1 else 100 - lichess.win_percent(before)
            if after is None:  # the player delivered mate
                w1 = 100.0
            else:
                w1 = lichess.win_percent(after) if pov == 1 else 100 - lichess.win_percent(after)
            judged = lichess.judge(before, after, me_white) if after is not None and uci != best[i] else None
            left = game["clocks"][i]
            prev_left = game["clocks"][i - 2] if i >= 2 else base
            rec = {
                "ply": i + 1,
                "san": board.san(move),
                "uci": uci,
                "fen": board.fen(),
                "phase": phase_of(i),
                "before": before,
                "after": after,
                "drop": round(max(0.0, w0 - w1), 2),
                "win_before": round(w0, 1),
                "judgement": judged,
                "best": best[i],
                "best_san": _san_line(board, pv[i] or [], 6),
                "reply_san": _san_line(_after(board, move), pv[i + 1] or [], 6),
                "left": left,
                "spent": None if left is None or prev_left is None else round(prev_left - left + inc, 1),
                "left_share": None if left is None else round(left / base, 3),
                "clock": prev_left,  # on the clock when the move began
                "scramble": prev_left is not None and prev_left <= SCRAMBLE,
                "opponent_erred": _opponent_erred(game, i),
                "only": only_move(evals[i], second[i], me_white),
            }
            if rec["drop"] >= COSTLY and judged:
                lines = game.get("refined", {}).get("lines", {}).get(str(i)) or {}
                best_line, reply_line = lines.get("best") or pv[i] or [], lines.get("reply") or pv[i + 1] or []
                threat = lines.get("threat")
                win = lambda e: None if e is None else (lichess.win_percent(e) if me_white else 100 - lichess.win_percent(e))
                w = {"best": win(evals[i]), "played": w1, "second": win(second[i][1]) if second[i] else None,
                     "pass": win(threat["eval"]) if threat else None, "prev": win(evals[i - 1]) if i else None}
                last = chess.Move.from_uci(game["moves"][i - 1]) if took else None  # for "the recapture"
                rec["cause"], rec["detail"], rec["punish"] = classify(
                    w, board, move, evals[i], after, best_line, reply_line, threat, last, rec["phase"])
                rec["w"] = {k: None if v is None else round(v, 1) for k, v in w.items()}
                # Puzzles need one clear answer: the best move beats every other by 10% or more.
                # "clear": the player's best move here; "refute": the opponent's punishment after it
                rec["clear"] = w["second"] is not None and w["best"] - w["second"] >= 10
                s1 = second[i + 1] if i + 1 < len(second) else None
                rec["refute"] = best[i + 1] if s1 and after is not None and win(s1[1]) - w1 >= 10 else None
                rec["last"] = game["moves"][i - 1] if i else None
                rec["best_san"] = _san_line(board, best_line, 8)
                rec["reply_san"] = _san_line(_after(board, move), reply_line, 8)
            out.append(rec)
        took = board.is_capture(move)
        board.push(move)
    return out


def _after(board: chess.Board, move: chess.Move) -> chess.Board:
    b = board.copy()
    b.push(move)
    return b


def _san_line(board: chess.Board, line: list[str], n: int) -> list[str]:
    b, out = board.copy(), []
    for uci in line[:n]:
        m = chess.Move.from_uci(uci)
        if m not in b.legal_moves:
            break
        out.append(b.san(m))
        b.push(m)
    return out


def only_move(best: dict, second: list | None, white: bool) -> bool:
    """Lichess's puzzle test: the best move stands out. It mates where the
    second-best doesn't, or beats it by 0.7 in winning chances (35 win%)."""
    if second is None:
        return False  # a single legal move is no puzzle
    pov = 1 if white else -1
    def chances(e):
        if "mate" in e:
            return pov * (1 if e["mate"] > 0 else -1)
        return pov * (2 / (1 + math.exp(-0.00368208 * e["cp"])) - 1)
    if "mate" in best and best["mate"] * pov > 0:
        return not ("mate" in second[1] and second[1]["mate"] * pov > 0)
    return chances(best) > chances(second[1]) + 0.7


def _opponent_erred(game: dict, i: int) -> bool:
    """Did the opponent's move just before this one throw away 15 win% or more?"""
    if i == 0:
        return False
    ev = game["analysis"]["evals"]
    b, a = (lichess.INITIAL if i == 1 else ev[i - 1]), ev[i]
    if b is None or a is None:
        return False
    their_white = (i - 1) % 2 == 0
    w0, w1 = lichess.win_percent(b), lichess.win_percent(a)
    return ((w0 - w1) if their_white else (w1 - w0)) >= 15


def classify(w: dict, before: chess.Board, move: chess.Move, e_best: dict, e_played: dict,
             best_line: list[str], reply_line: list[str], threat: dict | None,
             last: chess.Move | None, phase: str) -> tuple[str, str, bool]:
    """The cause of a costly move, decided by the engine's own numbers, each a
    win% from the player's side: `best` (the position before the move),
    `played` (after it), `second` (after the engine's second choice), `pass`
    (if the player had passed and the opponent moved again) and `prev` (before
    the opponent's last move). The board only names what happened.
    Returns (cause, detail, whether it was a failure to punish their blunder)."""
    me_white = before.turn == chess.WHITE
    mine = lambda e: e is not None and "mate" in e and (e["mate"] > 0) == me_white
    theirs = lambda e: e is not None and "mate" in e and (e["mate"] > 0) != me_white
    drop = w["best"] - w["played"]
    near = max(5.0, 0.25 * drop)  # "about the same" between two evals
    tol = min(6.0, near)  # the same, held tight where a threat is concerned
    after = _after(before, move)

    if theirs(e_played):
        b = _after(before, move)
        for uci in reply_line:
            m = chess.Move.from_uci(uci)
            if m not in b.legal_moves:
                break
            b.push(m)
        return "allowed_mate", f"mate in {abs(e_played['mate'])}" + (" (back rank)" if motifs.mated_on_back_rank(b) else ""), False
    if mine(e_best) and not mine(e_played):
        return "missed_mate", f"mate in {e_best['mate'] * (1 if me_white else -1)}", False
    # Their last move handed over 15% or more, and this move gave most of it back
    # without sinking below where things stood (a move that did is judged on its own)
    gift = w["best"] - w["prev"] if w["prev"] is not None else 0
    if gift >= 15 and w["prev"] - 5 <= w["played"] <= w["prev"] + 0.4 * gift:
        return ("missed_win" if w["best"] >= 60 else "missed_defence"), motifs.shot_detail(before, best_line, last), True
    # Winning, and let them into a perpetual check
    if w["best"] >= 60 and abs(w["played"] - 50) <= 5 and motifs.checks_given(after, reply_line, not before.turn) >= 3:
        return "allowed_tactic", "a perpetual check", False
    # No better than passing, against a forcing threat that other moves met too.
    # When the best move takes something, passing also means not taking it, so
    # the threat is measured against the second choice.
    takes = bool(best_line) and before.is_capture(chess.Move.from_uci(best_line[0]))
    met = w["second"] if takes and w["second"] is not None else w["best"]
    if w["pass"] is not None and met - w["pass"] >= 10 and abs(w["played"] - w["pass"]) <= tol \
            and (w["second"] is None or w["second"] - w["pass"] >= tol) \
            and motifs.forcing(motifs.passed(before), threat["pv"], threat["eval"]):
        return "ignored_threat", motifs.threat_detail(before, threat["pv"], threat["eval"]), False
    # About as good as the second choice: the cost is the best move's edge. When
    # the best move stood out (by 25%, or 15% for a capture, check or tactic) it
    # was the one to find: a winning shot, or (holding the balance) the only defence.
    if w["second"] is not None and w["played"] >= w["second"] - near:
        edge = w["best"] - w["second"]
        first = motifs.first_move(before, best_line)
        if edge >= 25 or (edge >= 15 and first is not None and motifs.sharp(before, first)):
            if w["best"] >= 60:
                return "missed_win", motifs.shot_detail(before, best_line, last), gift >= 15
            return "missed_defence", motifs.shot_detail(before, best_line, last), False
        return "positional", motifs.feature(before, move, reply_line, phase), False
    # Clearly worse than even the second choice. If their reply is the threat
    # they already had, the move didn't meet it (or only met half of it)…
    if threat and reply_line[:1] == threat["pv"][:1] and met - w["pass"] >= 10 \
            and chess.Move.from_uci(reply_line[0]).to_square != move.to_square \
            and motifs.forcing(motifs.passed(before), threat["pv"], threat["eval"]):
        return "ignored_threat", motifs.threat_detail(before, threat["pv"], threat["eval"]), False
    # …otherwise the move made its own problem
    cause, detail = motifs.reply_kind(before, move, reply_line)
    if cause != "positional":
        return cause, detail, False
    if drop >= 25:  # a collapse with nothing taken at once: an attack, or a combination that wins later
        if motifs.checks_given(after, reply_line, not before.turn) >= 2:
            return "allowed_tactic", "an attack on your king", False
        if motifs.settled(after, reply_line, not before.turn) >= 2:
            return "allowed_tactic", "a combination", False
    return "positional", motifs.feature(before, move, reply_line, phase), False


def conversion(game: dict) -> dict | None:
    """A game the player stood winning in (90% or more after move 10) but didn't win."""
    if game["result"] == "win":
        return None
    me_white = game["me"] == "white"
    best_i, best_w = None, 0.0
    for i, e in enumerate(game["analysis"]["evals"][20:], 20):
        if e is None:
            continue
        w = lichess.win_percent(e) if me_white else 100 - lichess.win_percent(e)
        if w > best_w:
            best_i, best_w = i, w
    if best_w < 90:
        return None
    return {"peak_ply": best_i, "peak": round(best_w, 1), "result": game["result"], "how": game["how"]}


def build(games: list[dict]) -> dict:
    analysed = [g for g in games if g.get("analysis")]
    per_game, all_moves = [], []
    for g in analysed:
        ms = moves_of(g)
        for m in ms:
            m["game"] = g["uuid"]
        all_moves += ms
        acc = lichess.accuracy([e for e in g["analysis"]["evals"][1:] if e is not None])
        per_game.append({"uuid": g["uuid"], "url": g["url"], "end_time": g["end_time"], "time_class": g["time_class"],
                         "me": g["me"], "result": g["result"], "how": g["how"], "opening": g["opening"], "eco": g["eco"],
                         "accuracy": round(acc[g["me"]], 1) if acc and acc[g["me"]] is not None else None,
                         "rating": g["players"][g["me"]]["rating"], "time_control": g["time_control"],
                         "opponent": g["players"]["black" if g["me"] == "white" else "white"],
                         "conversion": conversion(g), "pgn": g["pgn"]})
    return {"games": per_game, "moves": all_moves}


def summarise(data: dict) -> dict:
    """The ranked causes with their evidence, plus the game-level pictures."""
    games, moves = data["games"], data["moves"]
    n = len(games)
    order = sorted(games, key=lambda g: g["end_time"])
    half = {g["uuid"]: (0 if k < n // 2 else 1) for k, g in enumerate(order)}
    halves = [max(1, n // 2), max(1, n - n // 2)]
    total_cost = sum(m["drop"] for m in moves) / 100
    by = defaultdict(list)
    for m in moves:
        if m.get("cause") and not m["scramble"]:  # habits, from moves made with time to think
            by[m["cause"]].append(m)
    causes = []
    for c in CAUSES:
        ms = by.get(c, [])
        if not ms:
            continue
        cost = sum(m["drop"] for m in ms) / 100
        trend = [sum(m["drop"] for m in ms if half[m["game"]] == h) / 100 / halves[h] for h in (0, 1)]
        causes.append({
            "cause": c,
            "moves": len(ms),
            "games": len({m["game"] for m in ms}),
            "cost": round(cost, 2),
            "per_game": round(len(ms) / n, 2),
            "trend": [round(t, 3) for t in trend],  # points lost per game, first half vs second half
            "detail": Counter(_detail(m) for m in ms).most_common(6),
            "fast": round(sum(1 for m in ms if m["spent"] is not None and m["spent"] < 2) / len(ms), 2),
            "after_opponent_error": round(sum(m["opponent_erred"] for m in ms) / len(ms), 2),
            "examples": _examples(ms, games),
        })
    causes.sort(key=lambda c: -c["cost"])
    blunders = [m for m in moves if m.get("cause")]
    return {
        "games": n,
        "moves": len(moves),
        "total_cost": round(total_cost, 1),
        "costly": len(blunders),
        "causes": causes,
        "punish_rate": _punish_rate(moves),
        "time": _time_picture(moves, games),
        "scramble": _scramble(moves, games),
        "phases": _phase_picture(moves, n),
        "conversion": [g for g in games if g["conversion"]],
        "repeats": _repeats(moves),
    }


def _repeats(moves: list[dict]) -> list[dict]:
    """The same costly move, from the same position, in two or more games: a
    habit rather than an accident (almost always an opening line)."""
    groups = defaultdict(list)
    for m in moves:
        if m.get("cause"):
            groups[(" ".join(m["fen"].split()[:3]), m["uci"])].append(m)
    out = []
    for ms in groups.values():
        if len({m["game"] for m in ms}) >= 2:
            first = ms[0]
            out.append({"fen": first["fen"], "san": first["san"], "uci": first["uci"], "best": first["best"],
                        "best_line": first["best_san"], "times": len({m["game"] for m in ms}), "ply": first["ply"],
                        "drop": round(statistics.mean(m["drop"] for m in ms), 1), "cause": first["cause"],
                        "games": sorted({m["game"] for m in ms})})
    return sorted(out, key=lambda r: (-r["times"], -r["drop"]))


def _detail(m: dict) -> str:
    return m["detail"] or m["phase"]


def _examples(ms: list[dict], games: list[dict], k: int = 9) -> list[dict]:
    """The costliest instances, one per game, most recent first among equals."""
    seen, out = set(), []
    end = {g["uuid"]: g["end_time"] for g in games}
    for m in sorted(ms, key=lambda m: (-round(m["drop"] / 5), -end[m["game"]])):
        if m["game"] in seen:
            continue
        seen.add(m["game"])
        out.append(m)
        if len(out) == k:
            break
    return out


def _punish_rate(moves: list[dict]) -> dict:
    """When the opponent blundered, how often was the reply close to the best one?"""
    chances = [m for m in moves if m["opponent_erred"]]
    punished = [m for m in chances if m["uci"] == m["best"] or m["drop"] < 5]
    return {"chances": len(chances), "punished": len(punished),
            "rate": round(len(punished) / len(chances), 2) if chances else None}


def _time_picture(moves: list[dict], games: list[dict]) -> dict:
    """What the clock does to the player: blunders and accuracy by seconds left,
    in positions still open (20–80%: in a decided one there's little to lose),
    and where the time goes in the commonest time control."""
    open_ = [m for m in moves if m["clock"] is not None and 20 <= m["win_before"] <= 80]
    by_clock = {}
    for name, lo, hi in (("over 2 min", 120, math.inf), ("1–2 min", 60, 120), ("20–60 s", SCRAMBLE, 60),
                         (f"{SCRAMBLE} s or less", -1, SCRAMBLE)):
        ms = [m for m in open_ if lo < m["clock"] <= hi]
        by_clock[name] = {"moves": len(ms),
                          "blunder_rate": round(sum(m["judgement"] == "blunder" for m in ms) / len(ms), 3) if ms else None,
                          "costly_rate": round(sum(1 for m in ms if m.get("cause")) / len(ms), 3) if ms else None,
                          "accuracy": round(statistics.mean(lichess._move_accuracy(100, 100 - m["drop"]) for m in ms), 1)
                          if ms else None}
    tc = Counter(g["time_control"] for g in games).most_common(1)[0][0]
    control = {g["uuid"] for g in games if g["time_control"] == tc}
    mine = [m for m in moves if m["game"] in control and m["clock"] is not None]
    at = []
    for n in range(10, 60, 10):
        cs = [m["clock"] for m in mine if (m["ply"] + 1) // 2 == n]
        if len(cs) >= 20:
            at.append([n, round(statistics.median(cs))])
    spent = {p: statistics.median(xs) for p in ("opening", "middlegame", "endgame")
             if (xs := [m["spent"] for m in mine if m["phase"] == p and m["spent"] is not None])}
    timeouts = [g for g in games if g["result"] == "loss" and g["how"] == "timeout"]
    return {"by_clock": by_clock, "control": tc, "clock_at_move": at, "median_spent": spent,
            "lost_on_time": len(timeouts)}


def _scramble(moves: list[dict], games: list[dict]) -> dict:
    """Costly moves made with SCRAMBLE seconds or less, kept apart from the
    habits, and how games went once the clock got that low."""
    ms = [m for m in moves if m.get("cause") and m["scramble"]]
    reached = {m["game"] for m in moves if m["scramble"]}
    def score(gs):
        return round(100 * sum(1 if g["result"] == "win" else 0.5 if g["result"] == "draw" else 0 for g in gs) / len(gs)) if gs else None
    return {"seconds": SCRAMBLE, "moves": len(ms), "games": len({m["game"] for m in ms}),
            "cost": round(sum(m["drop"] for m in ms) / 100, 2),
            "reached": len(reached), "score_reached": score([g for g in games if g["uuid"] in reached]),
            "score_rest": score([g for g in games if g["uuid"] not in reached]),
            "detail": Counter(m["cause"] for m in ms).most_common(4),
            "examples": _examples(ms, games)}


def _phase_picture(moves: list[dict], n: int) -> dict:
    out = {}
    for p in ("opening", "middlegame", "endgame"):
        ms = [m for m in moves if m["phase"] == p]
        out[p] = {"moves": len(ms), "cost": round(sum(m["drop"] for m in ms) / 100, 2),
                  "costly": sum(1 for m in ms if m.get("cause"))}
    return out
