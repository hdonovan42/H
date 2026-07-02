#!/usr/bin/env bash
# WaymoWatch WATCHDOG (cron */6) — hung-loop killer ONLY, since 2026-07-02.
# The loop itself runs under systemd (deploy/waymowatch-loop.service, Restart=always): death is
# systemd's job now. The old flock -n starter lived here and its stale-lock no-op left the loop
# dead for 48.5 h (2026-06-27..29) — flock supervision is retired.
# What systemd CANNOT see is a HUNG loop (process up, not iterating): a running loop writes
# data/candidates/heartbeat every iteration; if the process exists but the heartbeat is >10 min
# stale, kill it — systemd respawns within 30 s.
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
HB=data/candidates/heartbeat
if pgrep -f 'live_capture.py --loop' >/dev/null; then
  if [ -f "$HB" ] && [ $(( $(date +%s) - $(stat -c %Y "$HB") )) -gt 600 ]; then
    echo "$(date -u +%FT%TZ) watchdog: heartbeat stale >600s — killing hung loop (systemd respawns)"
    pkill -f 'live_capture.py --loop'
  fi
fi
