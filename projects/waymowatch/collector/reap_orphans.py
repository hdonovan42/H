#!/usr/bin/env python3
"""Delete candidate jpgs that no `candidates` row references.

Orphans arise from two paths (both fixed 2026-08-07, but a reaper is the durable backstop —
any future path that drops a row without unlinking its files leaks silently otherwise):

  1. ingest()'s MERGE branch used to write a NEW-stamped crop+frame and repoint the row without
     unlinking the superseded pair (~4,800 files/day).
  2. Under ENOSPC the imwrite lands but the INSERT fails, stranding the pair with no row. The
     21 Jul - 7 Aug 2026 outage minted these by the hundred-thousand while the loop crash-looped.

By 2026-08-07 that was 430,412 files / 9.04 GB — 95% of data/candidates, and the backup rsync
faithfully archived every one of them.

SAFETY: a file younger than --grace minutes is NEVER touched. ingest() writes both jpgs before
the INSERT commits, so a just-written pair looks orphaned for a moment; the grace window is what
stops the reaper racing the live loop. Run with --dry-run first.
"""
import argparse
import os
import sqlite3
import sys
import time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAND_DIR = os.path.join(BASE, "data", "candidates")
DB = os.path.join(BASE, "data", "waymo.db")


def referenced(db):
    """Every basename any row points at. Basenames (not full paths): rows written on other hosts
    or before a path change still resolve, and CAND_DIR is the only directory we ever delete from."""
    con = sqlite3.connect(db, timeout=60)
    try:
        names = set()
        for crop, frame in con.execute("SELECT crop_path, frame_path FROM candidates"):
            for p in (crop, frame):
                if p:
                    names.add(os.path.basename(p))
        return names
    finally:
        con.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report only, delete nothing")
    ap.add_argument("--grace", type=int, default=60,
                    help="never delete a jpg younger than this many minutes (default 60)")
    ap.add_argument("--db", default=DB)
    ap.add_argument("--dir", default=CAND_DIR)
    args = ap.parse_args()

    ref = referenced(args.db)
    cutoff = time.time() - args.grace * 60

    scanned = orphans = deleted = skipped_young = 0
    freed = 0
    errors = 0
    for name in os.listdir(args.dir):
        if not name.endswith(".jpg"):
            continue
        scanned += 1
        if name in ref:
            continue
        path = os.path.join(args.dir, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        orphans += 1
        if st.st_mtime > cutoff:
            skipped_young += 1          # possibly mid-ingest — leave for the next run
            continue
        if args.dry_run:
            deleted += 1
            freed += st.st_size
            continue
        try:
            os.remove(path)
        except OSError:
            errors += 1
            continue
        deleted += 1
        freed += st.st_size

    verb = "would delete" if args.dry_run else "deleted"
    print(f"scanned {scanned} jpgs | referenced {len(ref)} | orphaned {orphans}")
    print(f"{verb} {deleted} ({freed / 1e9:.2f} GB) | kept {skipped_young} younger than "
          f"{args.grace} min | errors {errors}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
