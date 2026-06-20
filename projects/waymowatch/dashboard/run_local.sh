#!/usr/bin/env bash
# Run the WaymoNet inference dashboard locally (personal use). Then open http://localhost:3105
# Stop it with:  pkill -f 'dashboard/server.py'
set -e
cd "$(dirname "$0")"
export WAYMONET_WEIGHTS="${WAYMONET_WEIGHTS:-$HOME/waymonet_run1/weights/best.pt}"
export WAYMONET_DB="${WAYMONET_DB:-/nonexistent}"                 # no DB locally -> browse + galleries
export WAYMONET_BROWSE="${WAYMONET_BROWSE:-$HOME/waymonet_data}"  # Confirmed_Waymos/ Recent_candidates/
export WAYMONET_SPECIAL="${WAYMONET_SPECIAL:-$HOME/waymonet_eval/special}"
exec ../.venv/bin/python server.py
