#!/usr/bin/env bash
# AXIOM autonomous session launcher — cron entry point

set -euo pipefail

# Resolve script directory (works from any cwd)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Add node to PATH (nvm — works for any user)
if [ -d "$HOME/.nvm" ]; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
fi

# Ensure data directory exists
mkdir -p "$SCRIPT_DIR/data"

# Lock file to prevent overlapping runs
LOCKFILE="/tmp/axiom-cli.lock"

cleanup() {
  rm -f "$LOCKFILE"
}
trap cleanup EXIT

if [ -f "$LOCKFILE" ]; then
  OLDPID=$(cat "$LOCKFILE" 2>/dev/null || echo "")
  if [ -n "$OLDPID" ] && kill -0 "$OLDPID" 2>/dev/null; then
    echo "$(date -Iseconds) AXIOM already running (PID $OLDPID), skipping"
    exit 0
  fi
  # Stale lock — remove it
  rm -f "$LOCKFILE"
fi

echo $$ > "$LOCKFILE"

# Run the CLI
echo "$(date -Iseconds) Starting AXIOM session"
node "$SCRIPT_DIR/axiom-cli.js" --verbose 2>&1
EXIT_CODE=$?

echo "$(date -Iseconds) AXIOM session finished (exit code: $EXIT_CODE)"
exit $EXIT_CODE
