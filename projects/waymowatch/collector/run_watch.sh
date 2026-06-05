#!/usr/bin/env bash
# WaymoWatch live watch (cron entrypoint) — King's Cross (70 cams) + Park Royal depot (25 cams).
# Self-contained: cd + flock, so the crontab line needs no cd.
# flock -n => skip if a previous sweep is still running.
cd /home/hdonovan/hjd.ai/H/projects/waymowatch || exit 1
exec flock -n /tmp/waymowatch.lock .venv/bin/python collector/live_capture.py --wide 70 --pr 25
