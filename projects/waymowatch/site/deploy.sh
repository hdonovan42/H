#!/usr/bin/env bash
# Deploy the WaymoNet static site (homepage + /notes) to the VPS.
# Edit content under projects/waymowatch/site/ — notes are in site/notes/notes.md — then run:  ./deploy.sh
# The /notes page fetches notes.md live, so a reload shows edits with no rebuild.
set -e
cd "$(dirname "$0")"
rsync -az --exclude deploy.sh ./ root@vps-hel1:/var/www/waymonet/
echo "deployed -> https://waymonet.com   (notes: https://waymonet.com/notes)"
