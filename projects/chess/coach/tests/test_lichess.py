"""lichess.py against lichess.org's own analysis of 12 real games: the same
fixtures chess2's JavaScript is tested on, so both implementations agree.
Run: .venv/bin/python -m pytest tests  (or: .venv/bin/python tests/test_lichess.py)
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from lichess import INITIAL, accuracy, judge  # noqa: E402

GAMES = json.loads((HERE.parent.parent / "chess2" / "tests" / "lichess-games.json").read_text())


def ev(p):
    return {"mate": p["mate"]} if "mate" in p else {"cp": p["cp"]}


def test_accuracy_matches_lichess_exactly():
    for g in GAMES:
        a = accuracy([ev(p) for p in g["plies"]])
        assert {"white": round(a["white"]), "black": round(a["black"])} == g["accuracy"], g["id"]


def test_judgements_match_lichess():
    judged = 0
    for g in GAMES:
        for i, p in enumerate(g["plies"]):
            if "judgement" in p:
                got = judge(ev(g["plies"][i - 1]) if i else INITIAL, ev(p), i % 2 == 0)
                assert got == p["judgement"], f"{g['id']} ply {i + 1}"
                judged += 1
    assert judged == 115


if __name__ == "__main__":
    test_accuracy_matches_lichess_exactly()
    test_judgements_match_lichess()
    print("lichess.py: 24/24 accuracies and 115/115 judgements match lichess.org")
