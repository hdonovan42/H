#!/usr/bin/env bash
# AXIOM v2 deploy — build locally, sync to VPS, restart PM2
set -euo pipefail

VPS="hq@89.167.4.126"
REMOTE="/home/hq/axiom2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== AXIOM v2 Deploy ==="

# 1. Build frontend
echo "[1/8] Building frontend..."
cd "$PROJECT_DIR"
npm run build

# 2. Sync dist/ (built SPA)
echo "[2/8] Syncing dist/..."
rsync -az --delete "$PROJECT_DIR/dist/" "$VPS:$REMOTE/dist/"

# 3. Pull VPS package.json/lock back — pipeline may have added deps via npm install
echo "[3/8] Pulling VPS package.json (preserving pipeline-added deps)..."
rsync -az "$VPS:$REMOTE/server/package.json" "$PROJECT_DIR/server/package.json" 2>/dev/null || true
rsync -az "$VPS:$REMOTE/server/package-lock.json" "$PROJECT_DIR/server/package-lock.json" 2>/dev/null || true

# 4. Sync server/ (excluding .env, data/, node_modules, workspace/)
echo "[4/8] Syncing server/..."
# Sync server/ but exclude capabilities/ (pipeline-created modules live on VPS only)
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='workspace/' \
  --exclude='capabilities/' \
  "$PROJECT_DIR/server/" "$VPS:$REMOTE/server/"

# Sync Phase 0 capability modules (no --delete — preserves pipeline-created modules)
rsync -az "$PROJECT_DIR/server/capabilities/" "$VPS:$REMOTE/server/capabilities/"

# 5. Sync seed data
echo "[5/8] Syncing seed data..."
rsync -az "$PROJECT_DIR/src/data/" "$VPS:$REMOTE/src/data/"

# 6. Sync shared/ config
echo "[6/8] Syncing shared/..."
rsync -az "$PROJECT_DIR/shared/" "$VPS:$REMOTE/shared/"

# 6. Sync deploy configs
rsync -az "$PROJECT_DIR/deploy/" "$VPS:$REMOTE/deploy/"

# 7. Remote: install deps + restart PM2
echo "[7/8] Installing deps and restarting PM2..."
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

# 8. Verify capabilities loaded after restart
echo "[8/8] Verifying capabilities loaded..."
sleep 2
REGISTRY_LINE=$(ssh "$VPS" "tail -20 /home/hq/axiom2/logs/out.log" | grep '\[Registry\]' | tail -1)
FAILED=$(ssh "$VPS" "tail -20 /home/hq/axiom2/logs/out.log" | grep '\[Registry\] Failed' || true)

if [ -n "$FAILED" ]; then
  echo ""
  echo "WARNING: Some capabilities failed to load after deploy:"
  echo "$FAILED"
  echo ""
fi

echo "$REGISTRY_LINE"
echo ""
echo "=== Deploy complete ==="
echo "https://axiom.hjd.ai"
