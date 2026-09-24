"""The naming helpers on textbook positions, and the classifier's decision on
each branch, where the right answer isn't in doubt."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import chess  # noqa: E402
from insights import classify  # noqa: E402
from motifs import (character, forcing, mated_on_back_rank, passed, reply_kind, settled, shot_detail, tactic,  # noqa: E402
                    threat_detail, weakens_king)  # noqa: E402


def t(fen, uci):
    return tactic(chess.Board(fen), chess.Move.from_uci(uci))


def test_tactics():
    assert t("r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1", "d5c7") == "fork"               # royal knight fork
    assert t("4k3/3n4/8/8/8/8/8/4KB2 w - - 0 1", "f1b5") == "pin"                 # knight pinned to king
    assert t("4q3/8/8/4k3/8/8/R7/4K3 w - - 0 1", "a2e2") == "skewer"              # king in front of queen
    assert t("4k3/7q/8/8/8/3N4/8/1B2K3 w - - 0 1", "d3c5") == "discovered attack"  # bishop uncovered onto queen
    assert t("4k3/8/8/3r4/8/8/3Q4/4K3 w - - 0 1", "d2d5") == "hanging piece"       # free rook
    assert t("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", "a1a8") == "mate"
    assert t("4k3/8/8/8/8/8/3PP3/4K3 w - - 0 1", "d2d4") is None                    # quiet move


def test_back_rank():
    b = chess.Board("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1")
    b.push_uci("a1a8")
    assert mated_on_back_rank(b)


def kind(fen, move, reply):
    return reply_kind(chess.Board(fen), chess.Move.from_uci(move), reply)


def test_reply_kind():
    assert kind("4k3/8/4p3/8/8/2N5/8/4K3 w - - 0 1", "c3d5", ["e6d5"]) == ("moved_into_attack", "your knight")
    assert kind("4k3/8/4p3/3p4/8/8/3Q4/4K3 w - - 0 1", "d2d5", ["e6d5"]) == ("traded_down", "your queen")
    # the bishop walks away from the knight it guarded
    assert kind("4k3/8/8/3r4/8/3N4/4B3/4K3 w - - 0 1", "e2g4", ["d5d3"]) == ("left_undefended", "your knight")
    # an even trade on the square isn't losing the piece
    assert kind("4k3/8/4p3/3n4/8/8/6B1/4K3 w - - 0 1", "g2d5", ["e6d5"]) == ("positional", None)
    # past an even trade, their next move takes a loose rook
    assert kind("1q2k3/8/4p3/3n4/8/8/1R4B1/4K3 w - - 0 1", "g2d5", ["e6d5", "e1d1", "b8b2"]) == ("allowed_tactic", "your rook")
    # a quiet reply that forks
    assert kind("r3k3/8/8/3n4/8/8/8/2R1K3 w - - 0 1", "c1c2", ["d5b4"])[0] in ("allowed_tactic", "positional")


def test_threat_and_shot_details():
    b = chess.Board("4k3/8/8/3p4/4N3/8/8/4K3 w - - 0 1")  # black's pawn attacks the knight
    assert threat_detail(b, ["d5e4"], {"cp": -250}) == "your knight on e4"
    b = chess.Board("4k3/8/8/r7/8/8/3Q4/4K3 w - - 0 1")
    assert shot_detail(b, ["d2a5"], None) == "a free rook"
    # knight for knight, recaptured: an even trade, not a lost piece
    b = chess.Board("4k3/8/5n2/8/4N3/5P2/8/4K3 w - - 0 1")
    assert threat_detail(b, ["f6e4", "f3e4"], {"cp": 0}) == "their threat"

    # quiet moves with no tactic are named for what they do
    b = chess.Board("r1bqkb1r/pppp1pp1/5n1p/8/3QP3/2N5/PPP2PPP/R1B1KB1R w KQkq - 0 7")
    assert character(b, chess.Move.from_uci("e4e5")) == "a threat to the knight"
    assert character(b, chess.Move.from_uci("f1b5")) == "a quiet move"
    assert character(chess.Board("4k3/8/8/8/8/8/8/R3K3 w - - 0 1"), chess.Move.from_uci("a1a8")) == "a check"


def test_settled_and_forcing():
    b = chess.Board("4k3/8/5n2/8/4N3/5P2/8/4K3 b - - 0 1")
    assert settled(b, ["f6e4"], chess.BLACK) == 0             # the knight can be taken back
    assert settled(b, ["f6e4", "f3e4"], chess.BLACK) == 0     # and was: even
    assert settled(b, ["f6e4", "e1e2"], chess.BLACK) == 3     # and wasn't
    white = chess.Board("4k3/8/5n2/8/4N3/5P2/8/4K3 w - - 0 1")
    assert not forcing(passed(white), ["f6e4", "f3e4"], {"cp": 0})      # an even trade is no threat
    assert forcing(passed(chess.Board("4k3/8/8/3p4/4N3/8/8/4K3 w - - 0 1")), ["d5e4"], {"cp": -250})


def test_weakens_king():
    castled = "6k1/8/8/8/8/8/3P1PPP/6K1 w - - 0 1"
    assert weakens_king(chess.Board(castled), chess.Move.from_uci("g2g4"))
    assert not weakens_king(chess.Board(castled), chess.Move.from_uci("d2d4"))       # a centre pawn
    assert not weakens_king(chess.Board("4k3/8/8/8/8/8/3PPP2/4K3 w - - 0 1"), chess.Move.from_uci("f2f4"))  # king not castled


def decide(fen, move, w, e_best, e_played, best=(), reply=(), threat=None, last=None, phase="middlegame"):
    before = chess.Board(fen)
    return classify(w, before, chess.Move.from_uci(move), e_best, e_played, list(best), list(reply),
                    threat, chess.Move.from_uci(last) if last else None, phase)


QUIET = "4k3/8/8/8/8/8/3P4/4K3 w - - 0 1"


def test_classify_branches():
    # walked into mate
    assert decide(QUIET, "e1e2", {"best": 50, "played": 0, "second": 50, "pass": 50, "prev": 50},
                  {"cp": 0}, {"mate": -2})[0] == "allowed_mate"
    # their blunder handed over 30%, and the move gave it back
    c = decide(QUIET, "e1e2", {"best": 80, "played": 52, "second": 55, "pass": 78, "prev": 50}, {"cp": 300}, {"cp": 10})
    assert c[0] == "missed_win" and c[2] is True
    # no better than passing: an ignored threat
    c = decide("4k3/8/8/3p4/4N3/8/8/4K3 w - - 0 1", "e1e2", {"best": 50, "played": 20, "second": 48, "pass": 21, "prev": 50},
               {"cp": 0}, {"cp": -300}, threat={"eval": {"cp": -290}, "pv": ["d5e4"]})
    assert c[:2] == ("ignored_threat", "your knight on e4")
    # the second choice was about as good as the move, and the best stood out: a missed shot
    c = decide("4k3/8/8/r7/8/8/3Q4/4K3 w - - 0 1", "e1e2", {"best": 95, "played": 52, "second": 50, "pass": 94, "prev": 90},
               {"cp": 500}, {"cp": 10}, best=["d2a5"])
    assert c[:2] == ("missed_win", "a free rook") and c[2] is False
    # about the second choice, nothing stood out: positional
    assert decide(QUIET, "e1e2", {"best": 60, "played": 48, "second": 50, "pass": 59, "prev": 60},
                  {"cp": 60}, {"cp": -10})[0] == "positional"
    # much worse than the second choice, and the reply takes the piece that moved
    c = decide("4k3/8/4p3/8/8/2N5/8/4K3 w - - 0 1", "c3d5", {"best": 60, "played": 20, "second": 58, "pass": 59, "prev": 60},
               {"cp": 60}, {"cp": -300}, reply=["e6d5"])
    assert c[:2] == ("moved_into_attack", "your knight")

    # an even trade on the square, then nothing: positional, not traded_down
    c = decide("4k3/8/4p3/3n4/8/8/6B1/4K3 w - - 0 1", "g2d5", {"best": 60, "played": 45, "second": 58, "pass": 59, "prev": 60},
               {"cp": 60}, {"cp": -50}, reply=["e6d5"])
    assert c[0] == "positional"


def test_classify_audit_rules():
    # their blunder only got them level again: the defence they missed, still a failure to punish
    c = decide(QUIET, "e1e2", {"best": 55, "played": 32, "second": 40, "pass": 54, "prev": 30}, {"cp": 30}, {"cp": -200})
    assert c[0] == "missed_defence" and c[2] is True
    # the move sank well below where things stood before their blunder: judged on its own
    c = decide(QUIET, "e1e2", {"best": 80, "played": 30, "second": 78, "pass": None, "prev": 50}, {"cp": 300}, {"cp": -250})
    assert c[0] != "missed_win"
    # a threat that isn't forcing (a quiet king move) isn't an ignored threat
    c = decide(QUIET, "e1e2", {"best": 50, "played": 20, "second": 48, "pass": 21, "prev": 50},
               {"cp": 0}, {"cp": -300}, threat={"eval": {"cp": -290}, "pv": ["e8d7"]})
    assert c[0] != "ignored_threat"
    # winning, and let their queen check forever
    c = decide("6k1/1Q3ppp/8/8/2q5/7P/6P1/7K w - - 0 1", "b7b6", {"best": 90, "played": 50, "second": 85, "pass": 88, "prev": 90},
               {"cp": 800}, {"cp": 0}, reply=["c4f1", "h1h2", "f1f4", "h2h1", "f4f1", "h1h2", "f1f4"])
    assert c[:2] == ("allowed_tactic", "a perpetual check")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
    print("motifs and classify: all tests pass")
