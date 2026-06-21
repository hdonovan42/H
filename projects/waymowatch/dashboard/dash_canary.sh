#!/usr/bin/env bash
# WaymoNet inference health canary (homebox cron, */20) — coarse OUTER backstop.
# The real-time guard is in-process (infer_server.py probes every 3 s, 503s on degraded, self-exits
# on sustained failure). This cron is the belt-and-braces for a fully-hung process the in-process
# watchdog can't escape. The inference server can SILENTLY degrade — empty detections, no crash
# (observed 2026-06-21: ~20 h up -> 99.7% wn_conf=0; a restart fixed it). This POSTs a known
# confirmed-Waymo frame; a healthy model scores it ~0.73. If the top conf collapses below THRESH the
# model is dead -> restart waymonet-infer (the model service, on 3105; re-warms ~2 s) AND email.
# The homebox emails Resend directly (homebox->VPS ssh isn't set up); RESEND_API_KEY lives in
# ~/waymonet-dash/.resend_key (chmod 600). A restart alert is the signal to chase the root cause.
SVC="waymonet-infer"
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
echo "$ts CANARY FAIL conf=$conf -> restarting $SVC"
sudo systemctl restart "$SVC"
if [ -f "$KEYFILE" ]; then
  key="$(cut -d= -f2- "$KEYFILE")"
  curl -s -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
    -d "{\"from\":\"WaymoWatch <noreply@autosnipe.co.uk>\",\"to\":[\"$TO\"],\"subject\":\"WaymoNet inference auto-restarted — model had gone dead (canary conf $conf)\",\"html\":\"<p>The homebox WaymoNet inference service returned a collapsed canary score (<b>$conf</b>; healthy is ~0.73) and was <b>auto-restarted</b> by the outer cron canary at $ts UTC. (The in-process watchdog should normally catch this first.)</p><p>Candidates scored in the window before this may read wn_conf=0 and want a re-score. Worth chasing the root cause if this fires often. Log: ~/waymonet-dash/canary.log</p>\"}" >/dev/null \
    && echo "$ts restart alert emailed to $TO" || echo "$ts alert email FAILED"
else
  echo "$ts no $KEYFILE — cannot email restart alert"
fi
