"""Games: fetched from chess.com's public API into one JSON file per game.

The dataset starts where the ingest pipeline's store starts (2026-09-07): the
games before it sit behind a year's gap and aren't the player's current chess.
A file per game keeps everything mergeable between machines: whoever analyses
a game writes its file, and a game is only ever analysed once.
"""
from __future__ import annotations

import io
import json
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import chess
import chess.pgn

USERNAME = "harrydonovan"
SINCE = 1788801232  # end_time of the pipeline store's first game: 2026-09-07 17:13:52 UTC
API = "https://api.chess.com/pub"
USER_AGENT = "hjd.ai chess coach (https://hjd.ai)"  # Cloudflare refuses urllib's default


def fetch(url: str, etag: str | None) -> tuple[int, dict | None, str | None]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **({"If-None-Match": etag} if etag else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read()), r.headers.get("ETag")
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return 304, None, etag
        raise


def months_since(since: int, now: datetime) -> list[str]:
    start = datetime.fromtimestamp(since, timezone.utc)
    y, m, out = start.year, start.month, []
    while (y, m) <= (now.year, now.month):
        out.append(f"{API}/player/{USERNAME}/games/{y}/{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def record(game: dict) -> dict | None:
    """A chess.com game as the coach keeps it, or None if it isn't standard chess."""
    if game.get("rules") != "chess" or game.get("end_time", 0) < SINCE:
        return None
    pgn = chess.pgn.read_game(io.StringIO(game["pgn"]))
    if pgn is None or pgn.headers.get("SetUp") == "1":
        return None
    white, black = game["white"], game["black"]
    me = "white" if white["username"].lower() == USERNAME else "black"
    mine = white if me == "white" else black
    result = "win" if mine["result"] == "win" else "draw" if mine["result"] in DRAWS else "loss"
    moves, clocks = [], []
    for node in pgn.mainline():
        moves.append(node.move.uci())
        clocks.append(node.clock())
    return {
        "uuid": game["uuid"],
        "url": game["url"],
        "end_time": game["end_time"],
        "time_class": game["time_class"],
        "time_control": game["time_control"],
        "rated": game.get("rated", True),
        "me": me,
        "result": result,
        # how it ended, from the loser's side: checkmated, resigned, timeout, …
        "how": (black if white["result"] == "win" else white)["result"] if result != "draw" else mine["result"],
        "players": {c: {"name": p["username"], "rating": p["rating"]} for c, p in (("white", white), ("black", black))},
        "eco": pgn.headers.get("ECO"),
        "opening": opening_name(pgn.headers.get("ECOUrl")),
        "chesscom_accuracy": game.get("accuracies"),
        "pgn": game["pgn"],
        "moves": moves,
        "clocks": clocks,
    }


DRAWS = {"agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"}


def opening_name(url: str | None) -> str | None:
    """'…/Sicilian-Defense-Mengarini-Variation-2...Nc6-3.b4' → 'Sicilian Defense Mengarini Variation'."""
    if not url:
        return None
    slug = url.rstrip("/").rsplit("/", 1)[-1]
    return re.sub(r"(-|\.\.\.)\d+\..*$", "", slug).replace("-", " ") or None  # moves follow "-4." or "...4."


def sync(data: Path) -> int:
    """Write a file for every game since SINCE that isn't stored yet. Returns how many were new."""
    games_dir = data / "games"
    games_dir.mkdir(parents=True, exist_ok=True)
    etags_path = data / "etags.json"
    etags = json.loads(etags_path.read_text()) if etags_path.exists() else {}
    new = 0
    for url in months_since(SINCE, datetime.now(timezone.utc)):
        status, body, etag = fetch(url, etags.get(url))
        if status == 304 or body is None:
            continue
        for g in body.get("games", []):
            path = games_dir / f"{g.get('uuid')}.json"
            if path.exists():
                continue
            rec = record(g)
            if rec:
                path.write_text(json.dumps(rec))
                new += 1
        if etag:
            etags[url] = etag
        time.sleep(0.5)  # chess.com asks for serial, unhurried requests
    etags_path.write_text(json.dumps(etags, indent=1))
    return new


def load_all(data: Path) -> list[dict]:
    return sorted((json.loads(p.read_text()) for p in (data / "games").glob("*.json")), key=lambda g: g["end_time"])
