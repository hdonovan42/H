#!/usr/bin/env python3
"""coach — chess.com games in, computer analysis and coaching out.

    coach.py sync       fetch new games from chess.com
    coach.py analyse    run Stockfish over every game not yet analysed
    coach.py report     rebuild the insights from all analysed games
    coach.py update     all three: what a scheduled worker runs
    coach.py status     what the store holds

Everything lives under DATA (default ./data, or $COACH_DATA): one JSON file per
game. Any machine can run `update`; a lock keeps two writers from overlapping.
"""
from __future__ import annotations

import argparse
import fcntl
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

DATA = Path(os.environ.get("COACH_DATA", HERE / "data")).expanduser()
STOCKFISH = os.environ.get("COACH_STOCKFISH", str(HERE / "bin" / "stockfish19"))


def cmd_sync(args) -> None:
    import games
    print(f"sync: {games.sync(DATA)} new game(s)")


def cmd_analyse(args) -> None:
    import engine
    print(f"analyse: {engine.analyse(DATA, STOCKFISH, args.workers, args.limit)}")


def cmd_report(args) -> None:
    import report
    print(f"report: {report.build(DATA, HERE / 'site')}")


def cmd_update(args) -> None:
    cmd_sync(args)
    cmd_analyse(args)
    cmd_report(args)
    if args.publish:
        publish()


def publish() -> None:
    """Commit and push the rebuilt report if it changed: derived data only (the
    games and their analysis stay on the worker). Pushing is the deploy."""
    import subprocess
    report = HERE / "site" / "insights.json"
    git = lambda *a, **k: subprocess.run(["git", "-C", str(HERE), *a], text=True, capture_output=True, **k)
    git("add", str(report), check=True)
    if git("diff", "--cached", "--quiet", "--", str(report)).returncode == 0:
        print("publish: report unchanged")
        return
    git("commit", "-q", "-m", "coach: report rebuilt", "--", str(report), check=True)
    git("pull", "--rebase", "-q", check=True)
    git("push", "-q", check=True)
    print("publish: pushed")


def cmd_status(args) -> None:
    import games
    import engine
    all_games = games.load_all(DATA)
    done = sum(g.get("analysis", {}).get("settings") == engine.SETTINGS for g in all_games)
    print(f"{len(all_games)} games, {done} analysed, data in {DATA}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in [("sync", cmd_sync), ("analyse", cmd_analyse), ("report", cmd_report),
                     ("update", cmd_update), ("status", cmd_status)]:
        s = sub.add_parser(name)
        s.set_defaults(fn=fn)
        if name in ("analyse", "update"):
            s.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
            s.add_argument("--limit", type=int, help="analyse at most this many games")
        if name == "update":
            s.add_argument("--publish", action="store_true", help="commit and push the rebuilt report")
    args = p.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    if args.cmd in ("report", "status"):  # readers: game files are replaced atomically
        return args.fn(args)
    with open(DATA / ".lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.exit("coach: another run holds the lock")
        args.fn(args)


if __name__ == "__main__":
    main()
