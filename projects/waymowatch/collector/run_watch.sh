#!/usr/bin/env bash
# WaymoWatch live watch (cron entrypoint) — King's Cross (70 cams) + Park Royal depot (25 cams).
# Location-independent: cd to the project root relative to THIS script, so the same file works on
# the laptop and the VPS. flock -n => skip if a previous sweep is still running.
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
export OMP_NUM_THREADS=2 MKL_NUM_THREADS=2     # be a good neighbour on the shared box
exec flock -n /tmp/waymowatch.lock .venv/bin/python collector/live_capture.py --wide 70 --pr 25
