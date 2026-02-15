#!/bin/bash
set -euo pipefail

VPS_HOST="hq@89.167.4.126"
REMOTE_DIR="/home/hq/vault"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== VAULT Deploy ==="
echo "Source: $LOCAL_DIR"
echo "Target: $VPS_HOST:$REMOTE_DIR"
echo ""

# Build dashboard
echo ">>> Building dashboard..."
cd "$LOCAL_DIR/dashboard"
npm install --silent
npm run build
cd "$LOCAL_DIR"

# Sync project files (exclude runtime data)
echo ">>> Syncing files..."
rsync -avz --delete \
    --exclude '.env' \
    --exclude 'vault.db' \
    --exclude 'vault.db-wal' \
    --exclude 'vault.db-shm' \
    --exclude 'vault.pid' \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    --exclude '.venv' \
    --exclude 'config.yaml' \
    --exclude 'dashboard/node_modules' \
    "$LOCAL_DIR/" "$VPS_HOST:$REMOTE_DIR/"

# Setup venv and install on remote
echo ">>> Setting up Python environment..."
ssh "$VPS_HOST" << 'REMOTE'
cd /home/hq/vault
if [ ! -f .venv/bin/python3 ]; then
    python3 -m venv --without-pip .venv
    curl -sS https://bootstrap.pypa.io/get-pip.py | .venv/bin/python3
fi
.venv/bin/pip install -e . --quiet
echo "Dependencies installed."
REMOTE

# Install/reload systemd services (requires root)
echo ">>> Restarting services..."
ssh root@89.167.4.126 << 'ROOT'
cp /home/hq/vault/deploy/vault-api.service /etc/systemd/system/
cp /home/hq/vault/deploy/vault-daemon.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable vault-api vault-daemon
systemctl restart vault-api
systemctl restart vault-daemon
echo "vault-api and vault-daemon services restarted."
ROOT

echo ""
echo "=== Deploy complete ==="
echo "Dashboard: https://vault.hjd.ai"
echo "API:       ssh $VPS_HOST 'curl -s localhost:3200/api/v1/status | python3 -m json.tool'"
echo "Start:     ssh $VPS_HOST 'cd /home/hq/vault && .venv/bin/vault start'"
echo "Status:    ssh $VPS_HOST 'cd /home/hq/vault && .venv/bin/vault status'"
echo "Logs:      ssh $VPS_HOST 'cd /home/hq/vault && .venv/bin/vault logs'"
