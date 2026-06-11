#!/usr/bin/env python3
"""Bank a "no waymos" verdict: mark EXACTLY the recorded shown ids as rejects.

confirm_cycle.py records every candidate id it put on a sheet in
data/candidates/cycle_shown.json. When the user reviews those sheets and
replies "no waymos", run this — it rejects precisely what was shown (anything
since confirmed stays waymo), reports counts, and clears the record.

Usage:  .venv/bin/python collector/bank_shown.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import data_plane as dp  # noqa: E402
from live_capture import CAND_DIR  # noqa: E402

SHOWN_FILE = os.path.join(CAND_DIR, "cycle_shown.json")


def main():
    if not os.path.exists(SHOWN_FILE):
        print("nothing recorded — no sheets pending a verdict")
        return
    ids = json.load(open(SHOWN_FILE)).get("shown", [])
    if not ids:
        print("record empty — nothing to bank")
        os.remove(SHOWN_FILE)
        return
    con = dp.db_connect(dp.DEFAULT_DB)
    n = con.execute("UPDATE candidates SET status='reject' WHERE id IN (%s) "
                    "AND status NOT IN ('waymo','reject')" % ",".join(map(str, ids))).rowcount
    con.commit()
    pool = con.execute("SELECT COUNT(*) FROM candidates WHERE status='reject'").fetchone()[0]
    os.remove(SHOWN_FILE)
    print(f"banked {n} of {len(ids)} recorded shown ids as vetted rejects "
          f"(rest were already waymo/reject); reject pool now {pool}")


if __name__ == "__main__":
    main()
