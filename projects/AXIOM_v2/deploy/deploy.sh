#!/usr/bin/env bash
# AXIOM v2 deploy — build locally, sync to VPS, restart PM2
set -euo pipefail

VPS="hq@89.167.4.126"
REMOTE="/home/hq/axiom2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== AXIOM v2 Deploy ==="

# 1. Build frontend
echo "[1/6] Building frontend..."
cd "$PROJECT_DIR"
npm run build

# 2. Sync dist/ (built SPA)
echo "[2/6] Syncing dist/..."
rsync -az --delete "$PROJECT_DIR/dist/" "$VPS:$REMOTE/dist/"

# 3. Sync server/ (excluding .env, data/, node_modules, workspace/)
echo "[3/6] Syncing server/..."
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='workspace/' \
  "$PROJECT_DIR/server/" "$VPS:$REMOTE/server/"

# 4. Sync seed data
echo "[4/6] Syncing seed data..."
rsync -az "$PROJECT_DIR/src/data/" "$VPS:$REMOTE/src/data/"

# 5. Sync shared/ config
echo "[5/6] Syncing shared/..."
rsync -az "$PROJECT_DIR/shared/" "$VPS:$REMOTE/shared/"

# 6. Sync deploy configs
rsync -az "$PROJECT_DIR/deploy/" "$VPS:$REMOTE/deploy/"

# 7. Remote: install deps + restart PM2
echo "[6/6] Installing deps and restarting PM2..."
ssh "$VPS" bash <<'EOF'
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

  cd /home/hq/axiom2/server
  npm ci --omit=dev

  cd /home/hq/axiom2
  mkdir -p logs server/data server/workspace

  pm2 restart deploy/ecosystem.config.cjs --update-env 2>/dev/null \
    || pm2 start deploy/ecosystem.config.cjs
  pm2 save

  echo ""
  pm2 status
EOF

echo ""
echo "=== Deploy complete ==="
echo "https://axiom.hjd.ai"
