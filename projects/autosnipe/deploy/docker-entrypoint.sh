#!/bin/bash
set -e

# Start Xvfb virtual display
Xvfb :${DISPLAY_NUM} -ac -screen 0 ${WIDTH}x${HEIGHT}x24 -dpi 96 -nolisten tcp &
sleep 1

echo "AutoSnipe browser container ready (display :${DISPLAY_NUM}, ${WIDTH}x${HEIGHT})"

# Keep container running
tail -f /dev/null
