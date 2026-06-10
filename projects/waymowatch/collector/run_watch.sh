#!/usr/bin/env bash
# WaymoWatch watcher (cron supervisor entrypoint) — continuous ZONE loop, 24/7 (v0.5).
# Cron calls this every 6 min; flock -n means: loop already running -> no-op, loop died ->
# instant restart. The loop polls ALL ~480 Waymo-zone cams (tier-1 spine first) with threaded
# conditional GETs every 150s and decodes only fresh clips (ETag 304 = skip).
# WATCHDOG: a running loop writes data/candidates/heartbeat every iteration. If the lock is
# held but the heartbeat is >10 min stale, the loop is hung (not dead — flock can't catch
# that): kill it; the next cron tick restarts it.
# Location-independent: cd to the project root relative to THIS script (laptop and VPS alike).
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
HB=data/candidates/heartbeat
if ! flock -n /tmp/waymowatch.lock -c true; then
  # lock held -> loop alive; check it's actually making progress
  if [ -f "$HB" ] && [ $(( $(date +%s) - $(stat -c %Y "$HB") )) -gt 600 ]; then
    echo "$(date -u +%FT%TZ) watchdog: heartbeat stale >600s — killing hung loop"
    pkill -f 'live_capture.py --loop'
  fi
  exit 0
fi
export OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 PYTHONUNBUFFERED=1   # good neighbour on the shared box
exec flock -n /tmp/waymowatch.lock nice -n 10 .venv/bin/python collector/live_capture.py --loop
