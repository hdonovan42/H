#!/usr/bin/env bash
# Redeploy the WaymoNet dashboard to the homebox (code + model + image data) and restart it.
# Run from projects/waymowatch/dashboard/ on the laptop. Homebox runs it as a systemd service
# (waymonet-dash) bound to 0.0.0.0:3105 on the tailnet; the VPS nginx reverse-proxies
# dash.waymonet.com -> http://100.107.138.103:3105 (basic-auth, TLS). If the homebox is down the
# dash just 502s — nothing else on the VPS is affected (the whole point of this split).
set -e
HB="${HB:-h@homebox}"
rsync -az server.py index.html "$HB":~/waymonet-dash/
rsync -az ~/waymonet_run1/weights/best.pt "$HB":~/waymonet-dash/best.pt
rsync -az ~/waymonet_data/   "$HB":~/waymonet-dash/data/browse/
# WaymoNet hard-negatives (the trained model's own FPs) live VPS-only + gitignored; pull the FULL
# FRAMES into the special staging so they ride the existing special-gallery sync (frames only — the
# dash runs WaymoNet on full frames @704, so crops would mis-infer + duplicate tiles).
mkdir -p ~/waymonet_eval/special/hard_negatives
rsync -az --include='*_frame.jpg' --exclude='*' "${VPS:-hq@vps-hel1}":/home/hq/waymowatch/data/hard_negatives/ ~/waymonet_eval/special/hard_negatives/
rsync -az ~/waymonet_eval/special/ "$HB":~/waymonet-dash/data/special/
ssh "$HB" "sudo systemctl restart waymonet-dash && sleep 3 && systemctl is-active waymonet-dash"
echo "redeployed to homebox; dash.waymonet.com proxies to it once nginx+DNS are up"
