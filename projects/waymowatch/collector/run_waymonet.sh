#!/usr/bin/env bash
# WaymoNet scoring-worker supervisor (cron entrypoint), mirrors run_watch.sh.
# Cron calls this every few minutes; flock -n means: worker already running -> no-op,
# worker died -> instant restart. Cron-supervised so it's immune to the SSH-session
# lifecycle — a hand-launched `nohup` gets reaped by systemd-logind when the launching
# session ends (that's what kept killing it); cron jobs are not.
#
# The worker is a LIGHTWEIGHT HTTP client (requests + sqlite + jpg read — NO torch): it POSTs
# each unscored candidate's frame to the homebox WaymoNet endpoint and banks the verdict
# (wn_conf/wn_bbox/wn_scored/wn_hit). All inference runs on the homebox, never the VPS.
# Cron: */5 * * * * /home/hq/waymowatch/collector/run_waymonet.sh >> data/wn_worker.log 2>&1
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
export OMP_NUM_THREADS=1 PYTHONUNBUFFERED=1   # no compute here; just be a good neighbour
exec flock -n /tmp/waymonet-worker.lock nice -n 12 .venv/bin/python collector/waymonet_worker.py
