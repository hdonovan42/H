#!/usr/bin/env bash
set -euo pipefail

VPS="hq@89.167.4.126"
REMOTE="/home/hq/autosnipe"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== AutoSnipe Deploy ==="

# 1. Build frontend
echo "[1/5] Building frontend..."
cd "$PROJECT_DIR"
npm run build

# 2. Sync dist/
echo "[2/5] Syncing dist/..."
rsync -az --delete "$PROJECT_DIR/dist/" "$VPS:$REMOTE/dist/"

# 3. Sync server/
echo "[3/5] Syncing server/..."
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='data/' \
  "$PROJECT_DIR/server/" "$VPS:$REMOTE/server/"

# 4. Sync shared/
echo "[4/5] Syncing shared/..."
rsync -az "$PROJECT_DIR/shared/" "$VPS:$REMOTE/shared/"

# 5. Remote: install deps + restart PM2
echo "[5/5] Installing deps and restarting..."
ssh "$VPS" bash <<'EOF'
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

  cd /home/hq/autosnipe/server
  npm ci --omit=dev

  cd /home/hq/autosnipe
  mkdir -p logs server/data

  pm2 restart deploy/ecosystem.config.cjs --update-env 2>/dev/null \
    || pm2 start deploy/ecosystem.config.cjs
  pm2 save
EOF

echo ""
echo "=== Deploy complete ==="
