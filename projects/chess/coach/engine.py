"""Engine analysis: Stockfish on every position of every game, written into the
game's file.

One thread and a fixed node count per search, a fresh hash per game and a fixed
order make the result deterministic: any machine with the same binary and
settings computes identical numbers, so boxes can share the work. Positions are
searched last to first, so each search inherits the hash table of the positions
that follow it, and each gets the moves that led to it, so repetitions count.
"""
from __future__ import annotations

import json
import os
from multiprocessing import Pool
from pathlib import Path

import chess
import chess.engine

SETTINGS = {"engine": "Stockfish 19", "nodes": 1_000_000, "multipv": 2, "v": 1}
# The second pass, for costly moves only: full-length lines, and what the
# opponent would win if the player passed (was the threat already there?)
REFINE = {"nodes": 300_000, "plies": 8, "v": 1}
COSTLY = 10  # win% lost: the same bar as insights.COSTLY
HASH_MB = 64
_engine = None


def _start(binary: str) -> None:
    global _engine
    os.nice(19)  # the box stays usable; Stockfish inherits this
    _engine = chess.engine.SimpleEngine.popen_uci(binary)
    _engine.configure({"Threads": 1, "Hash": HASH_MB})


def _score(pov: chess.engine.PovScore) -> dict:
    s = pov.white()
    return {"mate": s.mate()} if s.is_mate() else {"cp": s.score()}


def _extend(board: chess.Board, line: list[str], want: int, key: str) -> list[str]:
    """The engine's line from `board`, extended by searching on from its end
    until it has `want` plies (stored lines are sometimes cut short)."""
    b, line = board.copy(), list(line)
    for uci in line:
        b.push_uci(uci)
    while len(line) < want and not b.is_game_over():
        pv = _engine.analyse(b, chess.engine.Limit(nodes=REFINE["nodes"]), game=key).get("pv") or []
        if not pv:
            break
        for m in pv[: want - len(line)]:
            b.push(m)
            line.append(m.uci())
    return line


def refine_game(game: dict) -> dict:
    """Lines for each costly move of the player's: the best line from before it,
    the reply line after it, and the threat line (the opponent to move again in
    the position before it)."""
    import lichess  # noqa: late import keeps workers light
    a, me_white = game["analysis"], game["me"] == "white"
    boards, b = [], chess.Board()
    for uci in game["moves"]:
        boards.append(b.copy())
        b.push_uci(uci)
    boards.append(b.copy())
    key = game["uuid"] + ":refine"
    out = {}
    for i, uci in enumerate(game["moves"]):
        if (i % 2 == 0) != me_white or a["evals"][i] is None or a["evals"][i + 1] is None or uci == a["best"][i]:
            continue
        before = lichess.INITIAL if i == 0 else a["evals"][i]
        w0, w1 = lichess.win_percent(before), lichess.win_percent(a["evals"][i + 1])
        if ((w0 - w1) if me_white else (w1 - w0)) < COSTLY:
            continue
        threat = None
        if not boards[i].is_check():
            passed = boards[i].copy(stack=False)
            passed.turn, passed.ep_square = not passed.turn, None
            passed = chess.Board(passed.fen())
            if passed.is_valid():
                info = _engine.analyse(passed, chess.engine.Limit(nodes=REFINE["nodes"]), game=key)
                threat = {"eval": _score(info["score"]),
                          "pv": _extend(passed, [m.uci() for m in info.get("pv", [])], REFINE["plies"], key)}
        out[str(i)] = {"best": _extend(boards[i], a["pv"][i] or [], REFINE["plies"], key),
                       "reply": _extend(boards[i + 1], a["pv"][i + 1] or [], REFINE["plies"], key),
                       "threat": threat}
    return {"settings": REFINE, "lines": out}


def analyse_game(path: str) -> str:
    game = json.loads(Path(path).read_text())
    if game.get("analysis", {}).get("settings") == SETTINGS:
        if game.get("refined", {}).get("settings") == REFINE:
            return "kept"
        game["refined"] = refine_game(game)
        _write(path, game)
        return "refined"
    board = chess.Board()
    boards = [board.copy()]
    for uci in game["moves"]:
        board.push_uci(uci)
        boards.append(board.copy())
    n = len(boards)
    evals, best, pv, second = [None] * n, [None] * n, [None] * n, [None] * n
    for i in reversed(range(n)):
        b = boards[i]
        if b.is_checkmate() or b.is_stalemate():
            evals[i] = None if b.is_checkmate() else {"cp": 0}
            continue
        infos = _engine.analyse(b, chess.engine.Limit(nodes=SETTINGS["nodes"]),
                                multipv=SETTINGS["multipv"], game=game["uuid"])
        top = infos[0]
        evals[i] = _score(top["score"])
        best[i] = top["pv"][0].uci()
        pv[i] = [m.uci() for m in top["pv"][:10]]
        if len(infos) > 1 and infos[1].get("pv"):
            second[i] = [infos[1]["pv"][0].uci(), _score(infos[1]["score"])]
    game["analysis"] = {"settings": SETTINGS, "evals": evals, "best": best, "pv": pv, "second": second}
    game["refined"] = refine_game(game)
    _write(path, game)
    return "analysed"


def _write(path: str, game: dict) -> None:
    tmp = Path(path).with_suffix(".tmp")
    tmp.write_text(json.dumps(game))
    tmp.replace(path)  # atomic: a killed run never leaves half a file


def analyse(data: Path, binary: str, workers: int, limit: int | None = None) -> dict:
    """Analyse every game file that lacks a current analysis, newest first."""
    paths = sorted((data / "games").glob("*.json"), key=lambda p: -json.loads(p.read_text())["end_time"])
    def current(p):
        g = json.loads(p.read_text())
        return g.get("analysis", {}).get("settings") == SETTINGS and g.get("refined", {}).get("settings") == REFINE
    todo = [str(p) for p in paths if not current(p)]
    if limit:
        todo = todo[:limit]
    counts = {"analysed": 0, "kept": len(paths) - len(todo)}
    if not todo:
        return counts
    with Pool(workers, initializer=_start, initargs=(binary,)) as pool:
        for i, outcome in enumerate(pool.imap_unordered(analyse_game, todo), 1):
            counts[outcome] = counts.get(outcome, 0) + 1
            print(f"\r  analysed {i}/{len(todo)}", end="", flush=True)
    print()
    return counts
