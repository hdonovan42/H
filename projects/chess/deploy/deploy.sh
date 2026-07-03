#!/usr/bin/env bash
# Deploy the chess analysis board to the VPS (chess.hjd.ai).
# SSH is tailnet-only: hq@vps-hel1 for files, root@vps-hel1 for nginx.
set -euo pipefail

cd "$(dirname "$0")/.."   # projects/chess

VPS_USER=hq@vps-hel1
VPS_ROOT=root@vps-hel1
DEST=/var/www/chess

# One-time web root (idempotent): owned by hq so deploys don't need root
ssh "$VPS_ROOT" "mkdir -p $DEST && chown hq:hq $DEST"

# Site files. First sync moves ~150MB of engine wasm; later syncs are deltas.
# NOTE: keep the favicon rsync AFTER the --delete rsync — the first pass
# removes the destination images/ dir, the second recreates it.
rsync -az --delete --info=stats1 analysis.html css js img "$VPS_USER:$DEST/"
ssh "$VPS_USER" "mkdir -p $DEST/images"
rsync -az ../../images/H-favicon.png "$VPS_USER:$DEST/images/"

# nginx vhost
scp -q deploy/chess.hjd.ai.conf "$VPS_ROOT:/etc/nginx/sites-available/chess.hjd.ai"
ssh "$VPS_ROOT" "ln -sf /etc/nginx/sites-available/chess.hjd.ai /etc/nginx/sites-enabled/chess.hjd.ai && nginx -t && systemctl reload nginx"

echo "Deployed to $DEST."
echo "If TLS not yet issued (needs DNS A record first):"
echo "  ssh $VPS_ROOT 'certbot --nginx -d chess.hjd.ai'"
