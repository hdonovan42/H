#!/usr/bin/env python3
"""Auto-bank threshold report — "can we lower the 0.75 cut yet?"

The auto-bank threshold is bounded by the CONFUSER CEILING (the highest score among confirmed
non-Waymos the current model gets wrong), NOT by the Waymo scores. You can auto-bank down to just
above that ceiling; the cost is the Waymos that fall below it (they go to manual review instead).

No separate store is needed — every banked candidate already records wn_conf + status + wn_model_ver
in waymo.db. This reads the LIVE DB, filtered to the CURRENTLY DEPLOYED model (collector/best.pt sha)
so Waymos and confusers are compared apples-to-apples (scores shift when the model changes).

  eval/threshold_report.py        # run before any threshold change or retrain

Powered by TfL Open Data.
"""
import hashlib
import os
import sqlite3

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def pct(data, q):
    s = sorted(data)
    if not s:
        return float("nan")
    i = q * (len(s) - 1)
    lo = int(i)
    return s[lo] if lo + 1 >= len(s) else s[lo] + (i - lo) * (s[lo + 1] - s[lo])


def main():
    con = sqlite3.connect(os.path.join(BASE, "data", "waymo.db"), timeout=60)
    ver = hashlib.sha256(open(os.path.join(BASE, "collector", "best.pt"), "rb").read()).hexdigest()[:12]

    def scores(where):
        return [r[0] for r in con.execute(
            f"SELECT wn_conf FROM candidates WHERE wn_model_ver=? AND wn_conf IS NOT NULL AND {where}",
            (ver,)).fetchall()]

    ways = scores("status='waymo' AND COALESCE(special,'')=''")
    rej = scores("status='reject'")
    # coverage caveat: candidates not yet re-scored under the deployed model are excluded
    way_total = con.execute("SELECT COUNT(*) FROM candidates WHERE status='waymo' AND COALESCE(special,'')=''").fetchone()[0]
    rej_total = con.execute("SELECT COUNT(*) FROM candidates WHERE status='reject'").fetchone()[0]

    print(f"deployed model: {ver}")
    print(f"confirmed Waymos scored by it: {len(ways)}/{way_total}  |  confirmed confusers: {len(rej)}/{rej_total}")
    if not ways or not rej:
        print("not enough data under this model yet (re-score the banked sets first)."); return
    print(f"\nWaymo scores : min {min(ways):.3f}  p10 {pct(ways,0.10):.3f}  median {pct(ways,0.5):.3f}  max {max(ways):.3f}")
    print(f"CONFUSER CEILING (highest confirmed non-Waymo): {max(rej):.3f}  <- auto-bank must stay above this")

    print(f"\n{'cut':>6} {'Waymo recall (auto-banked)':>27} {'confirmed-confuser leaks':>26}")
    for t in (0.30, 0.40, 0.50, 0.60, 0.70, 0.75, 0.80):
        rec = 100 * sum(1 for x in ways if x >= t) / len(ways)
        lk = sum(1 for x in rej if x >= t)
        print(f"{t:>6.2f} {rec:>25.1f}% {lk:>26}")

    ceil = max(rej)
    safe = round(ceil + 0.03, 2)
    rec_safe = 100 * sum(1 for x in ways if x >= safe) / len(ways)
    print(f"\nSAFE auto-bank cut now = {safe} (ceiling {ceil:.3f} + 0.03 margin): auto-banks {rec_safe:.0f}% of "
          f"Waymos with 0 confirmed confusers; the rest go to manual review.")
    print("CAVEAT: 'safe' is vs CONFIRMED confusers only — a NOVEL one can exceed the ceiling (one hit 0.67 "
          "before). Keep margin; re-run after each retrain (RUN_3 should push the ceiling down) and after "
          "banking new hard negatives. Cross-model history is frozen in the model_scores table.")


if __name__ == "__main__":
    main()
