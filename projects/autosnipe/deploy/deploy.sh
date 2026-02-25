#!/usr/bin/env bash
set -euo pipefail

VPS="hq@89.167.4.126"
REMOTE="/home/hq/autosnipe"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== AutoSnipe Deploy ==="

# 1. Build frontend
echo "[1/7] Building frontend..."
cd "$PROJECT_DIR"
npm run build

# 2. Sync dist/
echo "[2/7] Syncing dist/..."
rsync -az --delete "$PROJECT_DIR/dist/" "$VPS:$REMOTE/dist/"

# 3. Sync server/
echo "[3/7] Syncing server/..."
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='data/' \
  "$PROJECT_DIR/server/" "$VPS:$REMOTE/server/"

# 4. Sync shared/
echo "[4/7] Syncing shared/..."
rsync -az "$PROJECT_DIR/shared/" "$VPS:$REMOTE/shared/"

# 5. Sync deploy/
echo "[5/7] Syncing deploy/..."
rsync -az "$PROJECT_DIR/deploy/" "$VPS:$REMOTE/deploy/"

# 6. Remote: install deps + restart PM2
echo "[6/7] Installing deps and restarting..."
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

# 7. Ensure Docker container running
echo "[7/7] Checking browser container..."
ssh "$VPS" bash <<'EOF'
  if ! docker ps --format '{{.Names}}' | grep -q autosnipe-browser; then
    echo "Starting browser container..."
    cd /home/hq/autosnipe
    docker build -t autosnipe-browser -f deploy/Dockerfile deploy/
    docker run -d --name autosnipe-browser --restart unless-stopped --memory 512m autosnipe-browser
  else
    echo "Browser container already running"
  fi
EOF

echo ""
echo "=== Deploy complete ==="
