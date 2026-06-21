#!/usr/bin/env bash
# Runs ON THE VPS (hq crontab, every 15 min). Mirrors the WaymoNet dash reject/confuser galleries
# to the homebox (dash.waymonet.com) so they stay current with ZERO manual deploys.
#   VPS -> homebox is keyless over Tailscale SSH (both nodes on the tailnet).
#   The dash (server.py) re-globs the gallery dirs on every request, so NO service restart is needed.
# Galleries mirrored: funny / roof-box / i-pac / van_roof / edge_positive + hard_negatives + the
# Confirmed Waymos browse group (real_positives) — keeps the dash's confirmed count LIVE (no DB there).
# FULL FRAMES only (*_frame.jpg): the dash runs WaymoNet on full frames @704; crops would mis-infer
# and duplicate tiles. Additive (no --delete) so a homebox-only gallery is never clobbered.
set -euo pipefail

HB="${HB:-h@homebox}"
SRC="/home/hq/waymowatch/data"
DST="$HB:waymonet-dash/data/special"
SSH="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"

# 1. named confuser galleries (frames only) -> dash special/
rsync -az -e "$SSH" --include='*/' --include='*_frame.jpg' --exclude='*' \
  "$SRC/special/" "$DST/"

# 2. WaymoNet hard-negatives (the trained model's own false positives) -> its own gallery
rsync -az -e "$SSH" --include='*_frame.jpg' --exclude='*' \
  "$SRC/hard_negatives/" "$DST/hard_negatives/"

# 3. confirmed Waymos (real_positives, frames only) -> dash browse/Confirmed_Waymos so the count stays
#    LIVE. The dash has no DB; this browse group used to be a static hand-staged snapshot (stuck at 100).
#    EXACT mirror (--delete): unlike the confuser galleries this is not homebox-curated — it must equal
#    real_positives, else the old stale snapshot lingers and double-counts. --delete respects the
#    exclude filter, so only stale *_frame.jpg (not crops/other) are pruned.
rsync -az --delete -e "$SSH" --include='*_frame.jpg' --exclude='*' \
  "$SRC/real_positives/" "$HB:waymonet-dash/data/browse/Confirmed_Waymos/"

echo "[$(date -u +%FT%TZ)] dash mirror ok -> $HB"
