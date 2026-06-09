#!/usr/bin/env bash
# WaymoWatch watcher (cron supervisor entrypoint) — continuous spine loop, 24/7.
# Cron calls this every 6 min; flock -n means: loop already running -> no-op, loop died ->
# instant restart. The loop conditional-GETs ~115 spine cams (Park Royal depot -> A40/Westway
# -> Marylebone Rd -> Euston Rd/King's Cross) and decodes ONLY fresh clips (ETag 304 = skip),
# so every published clip on the corridor is processed — no refresh missed.
# Location-independent: cd to the project root relative to THIS script (laptop and VPS alike).
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
export OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 PYTHONUNBUFFERED=1   # good neighbour on the shared box
exec flock -n /tmp/waymowatch.lock nice -n 10 .venv/bin/python collector/live_capture.py --loop
