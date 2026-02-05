#!/usr/bin/env bash
# Install AXIOM cron job (hourly)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_SCRIPT="$SCRIPT_DIR/axiom-launch.sh"
LOG_FILE="$SCRIPT_DIR/data/axiom-cron.log"
CRON_ENTRY="0 * * * * $LAUNCH_SCRIPT >> $LOG_FILE 2>&1"

# Check if already installed
if crontab -l 2>/dev/null | grep -qF "axiom-launch.sh"; then
  echo "AXIOM cron job already installed:"
  crontab -l | grep "axiom-launch.sh"
  exit 0
fi

# Ensure data dir exists
mkdir -p "$SCRIPT_DIR/data"

# Add to crontab (preserving existing entries)
(crontab -l 2>/dev/null || true; echo "$CRON_ENTRY") | crontab -

echo "AXIOM cron job installed (hourly):"
echo "  $CRON_ENTRY"
echo ""
echo "Verify with: crontab -l"
echo "Remove with: crontab -e  (delete the axiom-launch.sh line)"
echo "Logs at: $LOG_FILE"
