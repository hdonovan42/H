"""The report: insights.json for the coach page (site/), built from every
analysed game. The page renders it; nothing here needs a browser."""
from __future__ import annotations

import json
import re
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import chess

import games
import insights
import lessons

CAUSE_ORDER = insights.CAUSES


def build(data: Path, site: Path) -> str:
    all_games = [g for g in games.load_all(data) if g.get("analysis")]
    if not all_games:
        return "no analysed games yet"
    built = insights.build(all_games)
    summary = insights.summarise(built)
    by_uuid = {g["uuid"]: g for g in built["games"]}
    total = sum(m["drop"] for m in built["moves"] if m.get("cause")) or 1

    causes = []
    for c in summary["causes"]:
        lesson = lessons.LESSONS[c["cause"]]
        causes.append({
            **{k: c[k] for k in ("cause", "moves", "games", "per_game", "trend", "detail",
                                 "fast", "after_opponent_error")},
            "share": round(100 * c["cost"] * 100 / total, 1),  # % of the win chances costly moves gave away
            "lesson": _lesson(lesson),
            "examples": [_example(m, by_uuid[m["game"]]) for m in c["examples"]],
        })
        if c["cause"] == "positional":  # not one habit: the kinds, each with its advice
            ms = [m for m in built["moves"] if m.get("cause") == "positional"]
            cost = sum(m["drop"] for m in ms) or 1
            kinds = defaultdict(list)
            for m in ms:
                kinds[m["detail"]].append(m)
            causes[-1]["features"] = sorted(({
                "feature": k, "share": round(100 * sum(m["drop"] for m in v) / cost, 1), "moves": len(v),
                "advice": lessons.FEATURES.get(k, ""),
                "example": _example(max(v, key=lambda m: m["drop"]), by_uuid[max(v, key=lambda m: m["drop"])["game"]]),
            } for k, v in kinds.items()), key=lambda f: -f["share"])

    played = sorted(built["games"], key=lambda g: g["end_time"])
    record = {r: sum(g["result"] == r for g in played) for r in ("win", "draw", "loss")}
    report = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "player": games.USERNAME,
        "period": [played[0]["end_time"], played[-1]["end_time"]],
        "games": len(played),
        "record": record,
        "by_time_class": _by(played, "time_class"),
        "accuracy": [{"t": g["end_time"], "a": g["accuracy"], "r": g["result"], "tc": g["time_class"]} for g in played],
        "moves": summary["moves"],
        "costly": summary["costly"],
        "causes": causes,
        "punish": summary["punish_rate"],
        "time": summary["time"],
        "scramble": {**summary["scramble"], "share": round(100 * summary["scramble"]["cost"] * 100 / total, 1),
                     "lesson": _game_lesson("time"),
                     "examples": [_example(m, by_uuid[m["game"]]) for m in summary["scramble"]["examples"]]},
        "phases": summary["phases"],
        "conversion": {"games": [_conversion(g) for g in summary["conversion"]], "lesson": _game_lesson("conversion")},
        "openings": _openings(played, built["moves"]),
        "positions": _positions(built["moves"], by_uuid),
        "repeats": [{**r, "colour": by_uuid[r["games"][0]]["me"], "pgn": by_uuid[r["games"][0]]["pgn"],
                     "opponents": [by_uuid[u]["opponent"]["name"] for u in r["games"]]} for r in summary["repeats"]],
        "list": [{"t": g["end_time"], "colour": g["me"], "opponent": g["opponent"], "result": g["result"],
                  "how": g["how"], "accuracy": g["accuracy"], "tc": g["time_class"], "url": g["url"], "pgn": g["pgn"]}
                 for g in reversed(played)],
    }
    site.mkdir(parents=True, exist_ok=True)
    (site / "insights.json").write_text(json.dumps(report, separators=(",", ":")))
    return f"{len(played)} games, {summary['costly']} costly moves, {len(causes)} causes → {site / 'insights.json'}"


def _game_lesson(key: str) -> dict:
    return _lesson(lessons.GAME_LESSONS[key])


def _lesson(lesson: dict) -> dict:
    """A lesson as the page wants it: drill links, and the Lichess puzzle themes
    ("angles") its in-page puzzles are drawn from."""
    return {**lesson, "drill": [{"name": n, "url": lessons.training_url(s)} for n, s in lesson["drill"]],
            "angles": [s for _, s in lesson["drill"] if not s.startswith("https://")] or ["mix"]}


def _example(m: dict, game: dict) -> dict:
    colour = game["me"]
    return {
        "fen": m["fen"], "san": m["san"], "uci": m["uci"], "best": m["best"], "best_line": m["best_san"],
        "reply_line": m["reply_san"], "drop": m["drop"], "win_before": m["win_before"], "ply": m["ply"],
        "move_no": (m["ply"] + 1) // 2, "colour": colour, "left": m["left"], "spent": m["spent"], "clock": m["clock"],
        "detail": insights._detail(m), "punish": m["punish"], "w": m["w"],
        "game": {"url": game["url"], "date": game["end_time"], "opponent": game["opponent"],
                 "time_class": game["time_class"], "result": game["result"]},  # the pgn is in "list"
    }


def _positions(moves: list[dict], by_uuid: dict) -> list[dict]:
    """The player's own positions as puzzles, newest first, each with one clear
    answer. "find": before a costly move, find the best one. "refute": after it,
    take the opponent's side and find how to punish it."""
    out = []
    for m in moves:
        if not m.get("cause"):
            continue
        g = by_uuid[m["game"]]
        other = "black" if g["me"] == "white" else "white"
        common = {"cause": m["cause"], "scramble": m["scramble"], "played": m["san"], "played_uci": m["uci"],
                  "drop": m["drop"], "clock": m["clock"], "punish": m["punish"], "ply": m["ply"],
                  "move_no": (m["ply"] + 1) // 2, "me": g["me"], "opponent": g["opponent"]["name"],
                  "date": g["end_time"], "url": g["url"]}
        if m["clear"] or m["only"]:  # a forced mate stands out even when the win% gap is small
            out.append({**common, "id": f"{m['game']}:{m['ply']}", "kind": "find", "fen": m["fen"], "colour": g["me"],
                        "best": m["best"], "line": m["best_san"], "last": m["last"], "only": m["only"]})
        if m["refute"]:
            b = chess.Board(m["fen"])
            b.push_uci(m["uci"])
            out.append({**common, "id": f"{m['game']}:{m['ply']}:refute", "kind": "refute", "fen": b.fen(),
                        "colour": other, "best": m["refute"], "line": m["reply_san"], "last": m["uci"], "only": False})
    return sorted(out, key=lambda p: (-p["date"], p["ply"]))


def _conversion(g: dict) -> dict:
    return {"url": g["url"], "date": g["end_time"], "opponent": g["opponent"], "result": g["result"],
            "how": g["how"], "time_class": g["time_class"], "colour": g["me"], "pgn": g["pgn"], **g["conversion"]}


def _by(played: list[dict], key: str) -> dict:
    out = defaultdict(lambda: {"games": 0, "win": 0, "draw": 0, "loss": 0, "ratings": []})
    for g in played:
        o = out[g[key]]
        o["games"] += 1
        o[g["result"]] += 1
        o["ratings"].append([g["end_time"], g["rating"]])
    return dict(out)


def _openings(played: list[dict], moves: list[dict]) -> list[dict]:
    """By colour and opening: games, score, accuracy, and what the opening phase cost."""
    opening_cost = defaultdict(float)
    for m in moves:
        if m["phase"] == "opening":
            opening_cost[m["game"]] += m["drop"] / 100
    rows = defaultdict(list)
    for g in played:
        rows[(g["me"], _family(g["opening"]))].append(g)
    out = []
    for (colour, name), gs in rows.items():
        score = sum(1 if g["result"] == "win" else 0.5 if g["result"] == "draw" else 0 for g in gs)
        accs = [g["accuracy"] for g in gs if g["accuracy"] is not None]
        out.append({"colour": colour, "opening": name, "games": len(gs), "score": round(100 * score / len(gs)),
                    "accuracy": round(statistics.mean(accs), 1) if accs else None,
                    "opening_cost": round(sum(opening_cost[g["uuid"]] for g in gs) / len(gs), 3)})
    return sorted(out, key=lambda r: (r["colour"], -r["games"]))


def _family(name: str | None) -> str:
    """'Sicilian Defense Mengarini Variation' → 'Sicilian Defense': the opening, not the line."""
    if not name:
        return "Unknown"
    words = re.sub(r"\.\.\.\d+\..*$", "", name).split()  # names stored before the "...4.Nxd4" fix
    for k, w in enumerate(words):
        if w in ("Defense", "Opening", "Game", "Gambit", "Attack", "System"):
            return " ".join(words[:k + 1])
    return " ".join(words[:2])
