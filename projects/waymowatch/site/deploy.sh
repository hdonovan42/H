#!/usr/bin/env bash
# Deploy the WaymoNet static site (homepage + /notes) to the VPS.
# NB notes.md is edited IN THE BROWSER at https://waymonet.com/notes/edit — the VPS copy is the
# source of truth, so we pull it back into the repo first (git keeps its history) and the push
# can never clobber a browser edit. The /notes page fetches notes.md live: no rebuild needed.
set -e
cd "$(dirname "$0")"
rsync -z root@vps-hel1:/var/www/waymonet/notes/notes.md ./notes/notes.md
# --chown: the sightings API (user hq) writes notes/ — root rsync must not hand it to uid 1000
rsync -az --exclude deploy.sh --exclude "*.tpl.html" --exclude "build_*.py" --chown=hq:hq ./ root@vps-hel1:/var/www/waymonet/
echo "deployed -> https://waymonet.com   (notes: https://waymonet.com/notes, editor: /notes/edit)"
