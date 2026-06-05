#!/usr/bin/env bash
# WaymoWatch wide King's Cross live watch (cron entrypoint). Self-contained: cd + flock,
# so the crontab line needs no cd. flock -n => skip if a previous sweep is still running.
cd /home/hdonovan/hjd.ai/H/projects/waymowatch || exit 1
exec flock -n /tmp/waymowatch.lock .venv/bin/python collector/live_capture.py --wide 70
