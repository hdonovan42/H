#!/bin/bash
# AXIOM v2 SP-Backup Installation Script
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="/var/backups/axiom"

echo "╔════════════════════════════════════════╗"
echo "║  AXIOM v2 SP-Backup — Installation    ║"
echo "╚════════════════════════════════════════╝"
echo ""

# ─── Check Dependencies ──────────────────────────────────────────
echo "Checking dependencies..."

check_dep() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "  ✓ $1 found: $(command -v "$1")"
    return 0
  else
    echo "  ✗ $1 NOT FOUND"
    return 1
  fi
}

DEPS_OK=true
check_dep rsync || DEPS_OK=false
check_dep flock || DEPS_OK=false
check_dep node  || DEPS_OK=false
check_dep bash  || DEPS_OK=false

if [ "$DEPS_OK" = false ]; then
  echo ""
  echo "ERROR: Missing required dependencies. Please install them first."
  exit 1
fi

echo ""
echo "All dependencies satisfied."
echo ""

# ─── Create Backup Directory ─────────────────────────────────────
echo "Creating backup directory: $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
chown "$(whoami)" "$BACKUP_DIR" 2>/dev/null || true
echo "  ✓ Backup directory ready"
echo ""

# ─── Make Scripts Executable ──────────────────────────────────────
chmod +x "$SCRIPT_DIR/backup.sh"
echo "  ✓ backup.sh made executable"
echo ""

# ─── Install Scheduler ───────────────────────────────────────────
install_systemd() {
  echo "Installing systemd timer..."
  
  # Update paths in service file
  sudo cp "$SCRIPT_DIR/axiom-backup.service" /etc/systemd/system/ 2>/dev/null
  sudo cp "$SCRIPT_DIR/axiom-backup.timer" /etc/systemd/system/ 2>/dev/null
  
  sudo systemctl daemon-reload
  sudo systemctl enable axiom-backup.timer
  sudo systemctl start axiom-backup.timer
  
  echo "  ✓ systemd timer installed and started"
  systemctl list-timers axiom-backup.timer --no-pager
}

install_cron() {
  echo "Installing cron fallback..."
  local cron_line="0 3 * * * /bin/bash $SCRIPT_DIR/backup.sh backup >> $BACKUP_DIR/cron.log 2>&1"
  
  # Check if already installed
  if crontab -l 2>/dev/null | grep -q "axiom.*backup"; then
    echo "  ✓ Cron entry already exists"
  else
    (crontab -l 2>/dev/null; echo "$cron_line") | crontab -
    echo "  ✓ Cron entry installed: $cron_line"
  fi
}

# Try systemd first, fall back to cron
if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  install_systemd || {
    echo "  ! systemd installation failed, falling back to cron"
    install_cron
  }
else
  install_cron
fi

echo ""

# ─── Run Initial Backup ──────────────────────────────────────────
echo "Running initial backup..."
bash "$SCRIPT_DIR/backup.sh" backup
echo ""

# ─── Verify Installation ─────────────────────────────────────────
echo "Running verification..."
bash "$SCRIPT_DIR/backup.sh" verify
echo ""

echo "╔════════════════════════════════════════╗"
echo "║  Installation Complete!                ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Commands:"
echo "  backup.sh backup   — Run backup now"
echo "  backup.sh restore  — Restore from snapshot"
echo "  backup.sh list     — List snapshots"
echo "  backup.sh verify   — Test integrity"
echo "  backup.sh status   — Check last backup"
echo "  backup.sh prune    — Apply retention policy"
