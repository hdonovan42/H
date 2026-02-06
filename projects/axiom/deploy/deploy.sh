#!/usr/bin/env bash
# AXIOM deploy — build locally, sync to VPS, restart PM2
set -euo pipefail

VPS="hq@89.167.4.126"
REMOTE="/home/hq/axiom"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== AXIOM Deploy ==="

# 1. Build frontend
echo "[1/5] Building frontend..."
cd "$PROJECT_DIR"
npm run build

# 2. Sync dist/ (built SPA)
echo "[2/5] Syncing dist/..."
rsync -az --delete "$PROJECT_DIR/dist/" "$VPS:$REMOTE/dist/"

# 3. Sync server/ (excluding .env, data/, node_modules)
echo "[3/5] Syncing server/..."
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='data/' \
  "$PROJECT_DIR/server/" "$VPS:$REMOTE/server/"

# 4. Sync seed data (actuators.json, hypotheses.json)
echo "[4/5] Syncing seed data..."
rsync -az "$PROJECT_DIR/src/data/" "$VPS:$REMOTE/src/data/"

# 5. Sync deploy configs (ecosystem, nginx conf)
rsync -az "$PROJECT_DIR/deploy/" "$VPS:$REMOTE/deploy/"

# 6. Remote: install deps + restart PM2
echo "[5/5] Installing deps and restarting PM2..."
ssh "$VPS" bash <<'EOF'
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

  cd /home/hq/axiom/server
  npm ci --omit=dev

  cd /home/hq/axiom
  pm2 restart deploy/ecosystem.config.cjs --update-env 2>/dev/null \
    || pm2 start deploy/ecosystem.config.cjs
  pm2 save

  echo ""
  pm2 status
EOF

echo ""
echo "=== Deploy complete ==="
echo "https://axiom.hjd.ai"
