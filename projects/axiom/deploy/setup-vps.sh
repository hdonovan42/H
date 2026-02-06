#!/usr/bin/env bash
# AXIOM one-time VPS provisioning
# Run: ssh hq@89.167.4.126 'bash -s' < deploy/setup-vps.sh
set -euo pipefail

echo "=== AXIOM VPS Setup ==="

# 1. Node.js via nvm
if [ ! -d "$HOME/.nvm" ]; then
  echo "[1/5] Installing nvm + Node 22..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm install 22
else
  echo "[1/5] nvm already installed"
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
fi

# 2. PM2
echo "[2/5] Installing PM2..."
npm install -g pm2
pm2 startup systemd -u hq --hp /home/hq 2>/dev/null || true

# 3. nginx + certbot
echo "[3/5] Installing nginx and certbot..."
sudo apt-get update -qq
sudo apt-get install -y -qq nginx certbot python3-certbot-nginx

# 4. Directory structure
echo "[4/5] Creating directories..."
mkdir -p /home/hq/axiom/{dist,server/data,src/data,logs,deploy}

# 5. Firewall
echo "[5/5] Configuring firewall..."
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Add DNS A record: axiom.hjd.ai -> $(curl -s ifconfig.me)"
echo "  2. Create /home/hq/axiom/server/.env with:"
echo "       ANTHROPIC_API_KEY=sk-ant-..."
echo "       CC_API_TOKEN=$(openssl rand -hex 32)"
echo "       PORT=3101"
echo "  3. Run deploy.sh from local machine"
echo "  4. Install nginx config:"
echo "       sudo cp /home/hq/axiom/deploy/nginx-axiom.conf /etc/nginx/sites-available/axiom"
echo "       sudo ln -sf /etc/nginx/sites-available/axiom /etc/nginx/sites-enabled/axiom"
echo "       sudo certbot --nginx -d axiom.hjd.ai"
echo "       sudo systemctl reload nginx"
echo "  5. Set up cron: cd /home/hq/axiom/server && bash cron-setup.sh"
echo "  6. PM2 log rotation: pm2 install pm2-logrotate"
