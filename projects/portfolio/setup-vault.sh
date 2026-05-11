#!/usr/bin/env bash
# One-time setup: clone the private PORTFOLIO data repo to ~/.portfolio-vault/.
# Run this on every new machine where you want to use the `portfolio` CLI.
set -euo pipefail

VAULT_DIR="$HOME/.portfolio-vault"
REPO_URL="${PORTFOLIO_REPO_URL:-https://github.com/hdonovan42/PORTFOLIO.git}"

if [ -d "$VAULT_DIR" ]; then
  echo "✓ Vault already present at $VAULT_DIR"
  exit 0
fi

git clone "$REPO_URL" "$VAULT_DIR"

if [ ! -f "$VAULT_DIR/portfolio.json" ]; then
  printf '{\n  "version": 1,\n  "transactions": [],\n  "positions": {}\n}\n' > "$VAULT_DIR/portfolio.json"
  (cd "$VAULT_DIR" && git add portfolio.json && git commit -m "init: empty portfolio" && git push)
fi

echo "✓ Vault ready at $VAULT_DIR"
