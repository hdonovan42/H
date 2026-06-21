#!/usr/bin/env bash
# WaymoNet dash health canary (homebox cron, */20).
# The inference server can SILENTLY degrade over a long run — returning empty detections with no
# crash/error (observed 2026-06-21: ~20 h up -> 99.7% wn_conf=0; a restart fixed it). This POSTs a
# known confirmed-Waymo frame; a healthy model scores it ~0.73. If the top conf collapses below
# THRESH the model has gone dead -> restart the dash. Restart is cheap (model re-warms in ~2 s).
URL="http://127.0.0.1:3105/api/infer"
CANARY="/home/h/waymonet-dash/canary_waymo.jpg"     # a confirmed Waymo (#40113), healthy top conf ~0.73
THRESH="0.30"
ts="$(date -u +%FT%TZ)"
conf="$(curl -s --max-time 25 --data-binary @"$CANARY" -H 'Content-Type: application/octet-stream' "$URL" \
  | python3 -c "import json,sys
try:
  b=json.load(sys.stdin).get('boxes',[]); print(b[0]['conf'] if b else 0.0)
except Exception: print(-1)" 2>/dev/null)"
[ -z "$conf" ] && conf="-1"
bad="$(python3 -c "print(1 if float('$conf')<float('$THRESH') else 0)" 2>/dev/null || echo 1)"
if [ "$bad" = "1" ]; then
  echo "$ts CANARY FAIL conf=$conf -> restarting waymonet-dash"
  sudo systemctl restart waymonet-dash
else
  echo "$ts canary ok conf=$conf"
fi
