#!/usr/bin/env bash
set -euo pipefail

VPS="hq@89.167.4.126"
REMOTE="/home/hq/autosnipe"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== AutoSnipe Deploy ==="

# 1. Build frontend
echo "[1/6] Building frontend..."
cd "$PROJECT_DIR"
npm run build

# 2. Sync dist/
echo "[2/6] Syncing dist/..."
rsync -az --delete "$PROJECT_DIR/dist/" "$VPS:$REMOTE/dist/"

# 3. Sync server/ (--checksum to catch stale files rsync -a misses)
echo "[3/6] Syncing server/..."
rsync -az --delete --checksum \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='data/' \
  "$PROJECT_DIR/server/" "$VPS:$REMOTE/server/"

# 4. Sync shared/, src/data/ + deploy config
echo "[4/6] Syncing shared/, static data, and deploy config..."
rsync -az --checksum "$PROJECT_DIR/shared/" "$VPS:$REMOTE/shared/"
rsync -az "$PROJECT_DIR/src/data/" "$VPS:$REMOTE/src/data/"
rsync -az "$PROJECT_DIR/deploy/ecosystem.config.cjs" "$VPS:$REMOTE/deploy/"

# 5. Remote: install deps + restart PM2
echo "[5/6] Installing deps and restarting..."
ssh "$VPS" bash <<'EOF'
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  export PATH="$PATH:/home/hq/.nvm/versions/node/v22.22.0/bin"

  cd /home/hq/autosnipe
  mkdir -p logs server/data

  # Stop PM2 process before rebuilding native modules
  pm2 stop autosnipe-api 2>/dev/null || true

  # Install deps with nvm Node (must match PM2's Node version)
  cd /home/hq/autosnipe/server
  npm ci --omit=dev

  cd /home/hq/autosnipe

  # Ensure Xvfb is running for headed Chrome
  if ! pgrep -f "Xvfb :99" > /dev/null; then
    echo "[Deploy] Starting Xvfb..."
    Xvfb :99 -screen 0 1280x800x24 &
    sleep 1
  else
    echo "[Deploy] Xvfb already running"
  fi

  pm2 delete autosnipe-api 2>/dev/null || true
  pm2 start deploy/ecosystem.config.cjs
  pm2 save
EOF

# 6. Health check — wait for server, fail loudly if broken
echo "[6/6] Health check..."
RETRIES=5
HEALTHY=false
for i in $(seq 1 $RETRIES); do
  sleep 2
  STATUS=$(ssh "$VPS" 'curl -s -o /dev/null -w "%{http_code}" http://localhost:3103/api/health' 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    HEALTHY=true
    break
  fi
  echo "  Attempt $i/$RETRIES — got $STATUS, retrying..."
done

if [ "$HEALTHY" = true ]; then
  BODY=$(ssh "$VPS" 'curl -s http://localhost:3103/api/health')
  echo ""
  echo "=== Deploy complete ==="
  echo "Health: $BODY"
else
  echo ""
  echo "!!! DEPLOY FAILED — server not healthy after $RETRIES attempts !!!"
  echo "Check logs: ssh $VPS 'export PATH=\$PATH:/home/hq/.nvm/versions/node/v22.22.0/bin && pm2 logs autosnipe-api --lines 20 --nostream'"
  exit 1
fi
