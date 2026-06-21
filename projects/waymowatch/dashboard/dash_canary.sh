#!/usr/bin/env bash
# WaymoNet dash health canary (homebox cron, */20).
# The inference server can SILENTLY degrade over a long run — returning empty detections with no
# crash/error (observed 2026-06-21: ~20 h up -> 99.7% wn_conf=0; a restart fixed it). This POSTs a
# known confirmed-Waymo frame; a healthy model scores it ~0.73. If the top conf collapses below
# THRESH the model has gone dead -> restart the dash (re-warms ~2 s) AND email the operator.
# The homebox emails Resend directly (homebox->VPS ssh isn't set up); RESEND_API_KEY lives in
# ~/waymonet-dash/.resend_key (chmod 600). A restart alert is the signal to chase the root cause.
URL="http://127.0.0.1:3105/api/infer"
CANARY="/home/h/waymonet-dash/canary_waymo.jpg"     # confirmed Waymo (#40113), healthy top conf ~0.73
KEYFILE="/home/h/waymonet-dash/.resend_key"
THRESH="0.30"
TO="donovanh59@gmail.com"
ts="$(date -u +%FT%TZ)"
conf="$(curl -s --max-time 25 --data-binary @"$CANARY" -H 'Content-Type: application/octet-stream' "$URL" \
  | python3 -c "import json,sys
try:
  b=json.load(sys.stdin).get('boxes',[]); print(b[0]['conf'] if b else 0.0)
except Exception: print(-1)" 2>/dev/null)"
[ -z "$conf" ] && conf="-1"
bad="$(python3 -c "print(1 if float('$conf')<float('$THRESH') else 0)" 2>/dev/null || echo 1)"
if [ "$bad" != "1" ]; then
  echo "$ts canary ok conf=$conf"
  exit 0
fi
echo "$ts CANARY FAIL conf=$conf -> restarting waymonet-dash"
sudo systemctl restart waymonet-dash
if [ -f "$KEYFILE" ]; then
  key="$(cut -d= -f2- "$KEYFILE")"
  curl -s -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
    -d "{\"from\":\"WaymoWatch <noreply@autosnipe.co.uk>\",\"to\":[\"$TO\"],\"subject\":\"WaymoNet dash auto-restarted — model had gone dead (canary conf $conf)\",\"html\":\"<p>The homebox WaymoNet dash returned a collapsed canary score (<b>$conf</b>; healthy is ~0.73) and was <b>auto-restarted</b> by dash_canary.sh at $ts UTC.</p><p>Candidates scored in the &le;20-min window before this may read wn_conf=0 and want a re-score. Worth chasing the root cause if this fires often. Log: ~/waymonet-dash/canary.log</p>\"}" >/dev/null \
    && echo "$ts restart alert emailed to $TO" || echo "$ts alert email FAILED"
else
  echo "$ts no $KEYFILE — cannot email restart alert"
fi
