#!/usr/bin/env bash
# Runs ON THE VPS (hq crontab, every 15 min). Mirrors the WaymoNet dash reject/confuser galleries
# to the homebox (dash.waymonet.com) so they stay current with ZERO manual deploys.
#   VPS -> homebox is keyless over Tailscale SSH (both nodes on the tailnet).
#   The dash (server.py) re-globs the gallery dirs on every request, so NO service restart is needed.
# Galleries mirrored: funny / roof-box / i-pac / van_roof / edge_positive  + the hard_negatives gallery.
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

echo "[$(date -u +%FT%TZ)] dash mirror ok -> $HB"
