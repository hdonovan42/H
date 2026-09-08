#!/usr/bin/env python3
"""ingest.py — pull chess.com games into a local SQLite store.

Chess.com has no webhook and no OAuth for this; the Published-Data API is
anonymous, CORS-open and ETag-cacheable, so we poll. Only the *current* month's
archive ever changes, and it is fetched conditionally — a quiet run is one 304.

The store starts empty by design (`--init`), holding a watermark so historic
games are never pulled. Stdlib only: this runs from cron on a small box.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
# The store lives beside the script by default (handy locally), but on the VPS
# the script sits in a git working tree, so CHESS_DATA_DIR moves it outside.
DATA_DIR = Path(os.environ.get("CHESS_DATA_DIR", SCRIPT_DIR)).expanduser()
DB_PATH = DATA_DIR / "chess.db"
STATE_PATH = DATA_DIR / "state.json"

USERNAME = "harrydonovan"
API = "https://api.chess.com/pub"
# Cloudflare 403s the default urllib UA. A contactable UA is what chess.com asks for.
USER_AGENT = "hjd.ai chess pipeline (donovanh59@gmail.com)"
TIMEOUT = 20

# chess.com reports each side's fate separately; only "win" is a win.
LOSS_RESULTS = {
    "checkmated", "timeout", "resigned", "lose", "abandoned",
    "kingofthehill", "threecheck", "bughousepartnerlose",
}
DRAW_RESULTS = {
    "agreed", "repetition", "stalemate", "insufficient",
    "50move", "timevsinsufficient",
}


# ---------------------------------------------------------------- http

def fetch(url: str, etag: str | None = None) -> tuple[int, dict | None, str | None]:
    """GET url. Returns (status, parsed_json_or_None, etag). 304 yields None body."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    if etag:
        req.add_header("If-None-Match", etag)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, json.loads(r.read().decode()), r.headers.get("ETag")
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return 304, None, etag
        raise


# ---------------------------------------------------------------- parsing

def pgn_headers(pgn: str) -> dict[str, str]:
    return dict(re.findall(r'^\[(\w+)\s+"(.*)"\]$', pgn, re.M))


def opening_from_eco_url(url: str | None) -> str | None:
    """'.../Philidor-Defense-Exchange-Variation-4.Nxd4-Nf6' -> 'Philidor Defense Exchange Variation'.

    The slug appends the concrete move sequence to the opening name; the moves
    begin at the first hyphen-segment that opens with a move number.
    """
    if not url:
        return None
    slug = url.rstrip("/").rsplit("/", 1)[-1]
    parts = slug.split("-")
    cut = len(parts)
    for i, p in enumerate(parts):
        if re.match(r"^\d+\.", p):
            cut = i
            break
    return " ".join(parts[:cut]).strip() or None


def clock_to_cs(text: str) -> int | None:
    """'0:02:58.3' -> centiseconds."""
    m = re.match(r"^(\d+):(\d+):(\d+(?:\.\d+)?)$", text)
    if not m:
        return None
    h, mi, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
    return round((h * 3600 + mi * 60 + s) * 100)


def parse_plies(pgn: str) -> list[tuple[int, str, int | None]]:
    """Extract (ply, san, clock_cs) from chess.com movetext.

    Movetext looks like: `1. e4 {[%clk 0:02:00.9]} 1... e5 {[%clk 0:01:59.8]}`.
    Header block is stripped first so bracketed tags can't be mistaken for moves.
    """
    body = re.sub(r'^\[.*?\]$', "", pgn, flags=re.M)
    out: list[tuple[int, str, int | None]] = []
    pattern = re.compile(
        r"\d+\.(?:\.\.)?\s*"                       # move number, "1." or "1..."
        r"([A-Za-z][^\s{}]*)"                      # SAN
        r"(?:\s*\{\[%clk\s*([\d:.]+)\]\})?"        # optional clock comment
    )
    for i, m in enumerate(pattern.finditer(body), start=1):
        out.append((i, m.group(1), clock_to_cs(m.group(2)) if m.group(2) else None))
    return out


def normalise(game: dict, username: str) -> tuple[dict, list[tuple]]:
    """Flatten one API game object into a row plus its ply rows."""
    lower = username.lower()
    if game["white"]["username"].lower() == lower:
        me, opp, colour = game["white"], game["black"], "white"
    else:
        me, opp, colour = game["black"], game["white"], "black"

    result = me.get("result")
    outcome = "win" if result == "win" else "draw" if result in DRAW_RESULTS else \
              "loss" if result in LOSS_RESULTS else "unknown"

    h = pgn_headers(game.get("pgn", ""))
    plies = parse_plies(game.get("pgn", ""))
    acc = game.get("accuracies") or {}

    # Time spent on a move = own clock before minus after, plus the increment.
    inc = 0
    tc = str(game.get("time_control", ""))
    if "+" in tc:
        try:
            inc = int(tc.split("+", 1)[1]) * 100
        except ValueError:
            inc = 0

    ply_rows = []
    prev: dict[int, int] = {}           # parity -> that side's previous clock
    for ply, san, clk in plies:
        parity = ply % 2
        spent = None
        if clk is not None and parity in prev:
            spent = prev[parity] - clk + inc
        if clk is not None:
            prev[parity] = clk
        ply_rows.append((game["uuid"], ply, san, clk, spent, None))

    row = {
        "uuid": game["uuid"],
        "url": game.get("url"),
        "end_time": game["end_time"],
        "end_date": datetime.fromtimestamp(game["end_time"], timezone.utc)
                            .strftime("%Y-%m-%d"),
        "time_class": game.get("time_class"),
        "time_control": tc,
        "rated": 1 if game.get("rated") else 0,
        "rules": game.get("rules"),
        "my_colour": colour,
        "my_rating": me.get("rating"),
        "my_result": result,
        "outcome": outcome,
        "opponent": opp.get("username"),
        "opp_rating": opp.get("rating"),
        "opp_result": opp.get("result"),
        "eco": h.get("ECO"),
        "eco_url": game.get("eco") or h.get("ECOUrl"),
        "opening": opening_from_eco_url(game.get("eco") or h.get("ECOUrl")),
        "termination": h.get("Termination"),
        "ply_count": len(ply_rows),
        "fen": game.get("fen"),
        "accuracy_mine": acc.get(colour),
        "accuracy_opp": acc.get("black" if colour == "white" else "white"),
        "pgn": game.get("pgn"),
        "ingested_at": int(time.time()),
    }
    return row, ply_rows


# ---------------------------------------------------------------- storage

SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
    uuid          TEXT PRIMARY KEY,
    url           TEXT,
    end_time      INTEGER NOT NULL,
    end_date      TEXT    NOT NULL,
    time_class    TEXT,
    time_control  TEXT,
    rated         INTEGER,
    rules         TEXT,
    my_colour     TEXT,
    my_rating     INTEGER,
    my_result     TEXT,
    outcome       TEXT,
    opponent      TEXT,
    opp_rating    INTEGER,
    opp_result    TEXT,
    eco           TEXT,
    eco_url       TEXT,
    opening       TEXT,
    termination   TEXT,
    ply_count     INTEGER,
    fen           TEXT,
    accuracy_mine REAL,
    accuracy_opp  REAL,
    pgn           TEXT NOT NULL,
    ingested_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS games_end_time ON games(end_time);
CREATE INDEX IF NOT EXISTS games_opening  ON games(eco);

-- eval_cp stays NULL until the Stockfish stage fills it in.
CREATE TABLE IF NOT EXISTS plies (
    uuid     TEXT NOT NULL,
    ply      INTEGER NOT NULL,
    san      TEXT,
    clock_cs INTEGER,
    spent_cs INTEGER,
    eval_cp  INTEGER,
    PRIMARY KEY (uuid, ply),
    FOREIGN KEY (uuid) REFERENCES games(uuid) ON DELETE CASCADE
);
"""


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript(SCHEMA)
    return con


def store(con: sqlite3.Connection, row: dict, ply_rows: list[tuple]) -> bool:
    """Upsert one game. Returns True if it was new."""
    cols = ", ".join(row)
    marks = ", ".join(["?"] * len(row))
    cur = con.execute(
        f"INSERT INTO games ({cols}) VALUES ({marks}) ON CONFLICT(uuid) DO NOTHING",
        list(row.values()),
    )
    new = cur.rowcount > 0
    if new and ply_rows:
        con.executemany(
            "INSERT OR REPLACE INTO plies (uuid, ply, san, clock_cs, spent_cs, eval_cp) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ply_rows,
        )
    return new


# ---------------------------------------------------------------- state

def load_state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text())
    return {}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n")


def archives_to_poll(now: datetime) -> list[str]:
    """Current month, plus the previous one for the first two days after rollover
    (a game finished at 23:59 lands in the old archive while we've moved on)."""
    months = [now]
    if now.day <= 2:
        months.append(now.replace(day=1) - timedelta(days=1))
    return [f"{API}/player/{USERNAME}/games/{d:%Y}/{d:%m}" for d in months]


# ---------------------------------------------------------------- commands

def cmd_init(args) -> int:
    """Start the dataset fresh: seed the single most recent game, watermark there."""
    if DB_PATH.exists() and not args.force:
        print(f"  ✗ {DB_PATH.name} already exists. Use --force to recreate.", file=sys.stderr)
        return 1
    if args.force:
        DB_PATH.unlink(missing_ok=True)
        for suffix in ("-wal", "-shm"):
            DB_PATH.with_name(DB_PATH.name + suffix).unlink(missing_ok=True)

    status, body, _ = fetch(f"{API}/player/{USERNAME}/games/archives")
    archives = body["archives"]
    if not archives:
        print("  ✗ No archives for this account.", file=sys.stderr)
        return 1

    # Walk back from the newest archive until we find one with a game in it.
    game = None
    for url in reversed(archives):
        _, arch, _ = fetch(url)
        games = arch.get("games") or []
        if games:
            game = max(games, key=lambda g: g["end_time"])
            break
    if game is None:
        print("  ✗ Archives listed but all empty.", file=sys.stderr)
        return 1

    con = connect(DB_PATH)
    row, plies = normalise(game, USERNAME)
    store(con, row, plies)
    con.commit()

    save_state({
        "username": USERNAME,
        # Everything at or before this is deliberately out of scope — the dataset
        # starts here rather than backfilling four years of history.
        "watermark": game["end_time"],
        "etags": {},
        "initialised_at": int(time.time()),
        "last_run": int(time.time()),
    })

    print(f"  ✓ Fresh store created at {DB_PATH}")
    print(f"    Seeded 1 game; watermark set to {row['end_date']} "
          f"({datetime.fromtimestamp(game['end_time'], timezone.utc):%H:%M:%S} UTC).")
    print(f"    {len(archives)} historic archives skipped by design.")
    report(con)
    return 0


def cmd_poll(args) -> int:
    state = load_state()
    if not state:
        print("  ✗ No state.json — run `ingest.py init` first.", file=sys.stderr)
        return 1

    con = connect(DB_PATH)
    watermark = state.get("watermark", 0)
    etags = state.get("etags", {})
    added, highest, requests_made, not_modified = 0, watermark, 0, 0

    for url in archives_to_poll(datetime.now(timezone.utc)):
        status, body, etag = fetch(url, etags.get(url))
        requests_made += 1
        if status == 304 or body is None:
            not_modified += 1
            continue
        etags[url] = etag
        for game in body.get("games", []):
            if game["end_time"] <= watermark:
                continue
            row, plies = normalise(game, USERNAME)
            if store(con, row, plies):
                added += 1
                if args.verbose:
                    print(f"    + {row['end_date']} {row['time_class']:<7} "
                          f"{row['outcome']:<5} vs {row['opponent']} ({row['opening']})")
            highest = max(highest, game["end_time"])

    con.commit()
    state["watermark"] = highest
    state["etags"] = etags
    state["last_run"] = int(time.time())
    save_state(state)

    print(f"  {added} new game(s) · {requests_made} request(s), {not_modified} not-modified")
    if args.verbose:
        report(con)
    return 0


def report(con: sqlite3.Connection) -> None:
    total, = con.execute("SELECT COUNT(*) FROM games").fetchone()
    plies, = con.execute("SELECT COUNT(*) FROM plies").fetchone()
    print(f"\n  Store: {total} game(s), {plies} plies")
    rows = con.execute(
        "SELECT end_date, time_class, my_colour, outcome, my_rating, opponent, "
        "opp_rating, opening, ply_count, termination FROM games "
        "ORDER BY end_time DESC LIMIT 5"
    ).fetchall()
    for r in rows:
        print(f"    {r[0]}  {r[1]:<7} as {r[2]:<5} {r[3]:<5} "
              f"{r[4]} vs {r[5]} ({r[6]})")
        print(f"      {r[7]}  ·  {r[8]} plies  ·  {r[9]}")


def _recent(con: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    con.row_factory = sqlite3.Row
    return list(con.execute(
        "SELECT * FROM games ORDER BY end_time DESC LIMIT ?", (limit,)))


def cmd_list(args) -> int:
    """Numbered recent games — the numbers are what `show` takes."""
    rows = _recent(connect(DB_PATH), args.number)
    if not rows:
        print("  (store is empty)")
        return 0
    for i, r in enumerate(rows, 1):
        when = datetime.fromtimestamp(r["end_time"], timezone.utc).strftime("%m-%d %H:%M")
        mark = {"win": "+", "loss": "-", "draw": "="}.get(r["outcome"], "?")
        print(f"  {i:>3}. {mark} {when}  {r['time_class']:<7} as {r['my_colour']:<5} "
              f"{r['my_rating']:>4} vs {r['opponent'][:20]:<20} ({r['opp_rating']})")
        print(f"       {r['opening']}")
    print(f"\n  `ingest.py show <n>` for the PGN.")
    return 0


def cmd_show(args) -> int:
    """Print one game: summary, then bare PGN to paste into analysis.html."""
    con = connect(DB_PATH)
    con.row_factory = sqlite3.Row
    if args.game.isdigit():
        rows = _recent(con, int(args.game))
        if len(rows) < int(args.game):
            print(f"  ✗ Only {len(rows)} game(s) in the store.", file=sys.stderr)
            return 1
        r = rows[int(args.game) - 1]
    else:
        r = con.execute("SELECT * FROM games WHERE uuid = ?", (args.game,)).fetchone()
        if r is None:
            print(f"  ✗ No game with uuid {args.game}", file=sys.stderr)
            return 1

    if not args.pgn_only:
        when = datetime.fromtimestamp(r["end_time"], timezone.utc)
        print(f"  {when:%Y-%m-%d %H:%M:%S} UTC · {r['time_class']} {r['time_control']}")
        print(f"  {r['outcome'].upper()} as {r['my_colour']} — {r['termination']}")
        print(f"  {r['my_rating']} vs {r['opponent']} ({r['opp_rating']})")
        print(f"  {r['opening']} [{r['eco']}] · {r['ply_count']} plies")
        print(f"  {r['url']}")
        spent = con.execute(
            "SELECT ROUND(AVG(spent_cs)/100.0,2), ROUND(MAX(spent_cs)/100.0,1) "
            "FROM plies WHERE uuid = ? AND spent_cs IS NOT NULL AND ply % 2 = ?",
            (r["uuid"], 1 if r["my_colour"] == "white" else 0)).fetchone()
        if spent and spent[0] is not None:
            print(f"  your clock: {spent[0]}s/move average, {spent[1]}s longest think")
        print()
    print(r["pgn"])
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    i = sub.add_parser("init", help="create a fresh store seeded with the latest game")
    i.add_argument("--force", action="store_true", help="delete an existing store first")
    i.set_defaults(func=cmd_init)

    q = sub.add_parser("poll", help="fetch games newer than the watermark")
    q.add_argument("-v", "--verbose", action="store_true")
    q.set_defaults(func=cmd_poll)

    s = sub.add_parser("status", help="show what the store holds")
    s.set_defaults(func=lambda a: (report(connect(DB_PATH)), 0)[1])

    l = sub.add_parser("list", help="numbered recent games")
    l.add_argument("-n", "--number", type=int, default=15)
    l.set_defaults(func=cmd_list)

    w = sub.add_parser("show", help="print one game's PGN (by list number or uuid)")
    w.add_argument("game", help="list number (1 = most recent) or a game uuid")
    w.add_argument("--pgn-only", action="store_true", help="omit the summary header")
    w.set_defaults(func=cmd_show)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
