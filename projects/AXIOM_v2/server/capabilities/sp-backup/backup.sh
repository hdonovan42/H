#!/bin/bash
# AXIOM v2 SP-Backup: Automated Incremental Workspace Backup
# Self-Preservation capability — backup, restore, list, prune, verify, status
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config.json"

# ─── Config Loading (uses node since jq may not be available) ────
load_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: Config file not found: $CONFIG_FILE"
    exit 1
  fi
  
  SOURCE_PATH=$(node -e "const c=require('$CONFIG_FILE'); console.log(c.source_paths[0])")
  BACKUP_DEST=$(node -e "const c=require('$CONFIG_FILE'); console.log(c.backup_dest)")
  EXCLUDE_PATTERNS=$(node -e "const c=require('$CONFIG_FILE'); c.exclude_patterns.forEach(p => console.log(p))")
  RETAIN_DAILY=$(node -e "const c=require('$CONFIG_FILE'); console.log(c.retention.daily)")
  RETAIN_WEEKLY=$(node -e "const c=require('$CONFIG_FILE'); console.log(c.retention.weekly)")
  RETAIN_MONTHLY=$(node -e "const c=require('$CONFIG_FILE'); console.log(c.retention.monthly)")
  DISK_THRESHOLD_MB=$(node -e "const c=require('$CONFIG_FILE'); console.log(c.disk_free_threshold_mb)")
  LOG_FILE=$(node -e "const c=require('$CONFIG_FILE'); console.log(c.log_file)")
  STATUS_FILE=$(node -e "const c=require('$CONFIG_FILE'); console.log(c.status_file)")
  LOCK_FILE=$(node -e "const c=require('$CONFIG_FILE'); console.log(c.lock_file)")
}

# ─── Logging ──────────────────────────────────────────────────────
log() {
  local msg="[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $1"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE" 2>/dev/null
}

# ─── Write Status JSON (atomic via tmp+mv) ───────────────────────
write_status() {
  local result="$1"
  local duration="$2"
  local snapshot="$3"
  local size_bytes="$4"
  local transferred="$5"
  local retained="$6"
  local pruned="$7"
  local disk_free="$8"
  local error="$9"
  
  local tmp_status="${STATUS_FILE}.tmp"
  
  node -e "
    const status = {
      lastRun: new Date().toISOString(),
      result: process.argv[1],
      duration_seconds: parseInt(process.argv[2]),
      snapshot: process.argv[3],
      size_bytes: parseInt(process.argv[4]),
      transferred_bytes: parseInt(process.argv[5]),
      snapshots_retained: parseInt(process.argv[6]),
      snapshots_pruned: parseInt(process.argv[7]),
      disk_free_bytes: parseInt(process.argv[8]),
      error: process.argv[9] === 'null' ? null : process.argv[9]
    };
    require('fs').writeFileSync(process.argv[10], JSON.stringify(status, null, 2));
  " "$result" "$duration" "$snapshot" "$size_bytes" "$transferred" "$retained" "$pruned" "$disk_free" "$error" "$tmp_status"
  
  mv "$tmp_status" "$STATUS_FILE"
}

# ─── Build Exclude Args ──────────────────────────────────────────
build_exclude_args() {
  local exclude_args=""
  while IFS= read -r pattern; do
    [ -n "$pattern" ] && exclude_args="$exclude_args --exclude=$pattern"
  done <<< "$EXCLUDE_PATTERNS"
  echo "$exclude_args"
}

# ─── Disk Space Check ────────────────────────────────────────────
check_disk_space() {
  local avail_kb=$(df --output=avail "$BACKUP_DEST" 2>/dev/null | tail -1 | tr -d ' ')
  local avail_mb=$((avail_kb / 1024))
  
  if [ "$avail_mb" -lt "$DISK_THRESHOLD_MB" ]; then
    log "ERROR: Insufficient disk space. Available: ${avail_mb}MB, Required: ${DISK_THRESHOLD_MB}MB"
    return 1
  fi
  
  log "Disk space OK: ${avail_mb}MB available (threshold: ${DISK_THRESHOLD_MB}MB)"
  return 0
}

# ─── Get Latest Snapshot ─────────────────────────────────────────
get_latest_snapshot() {
  if [ -d "$BACKUP_DEST" ]; then
    ls -1d "$BACKUP_DEST"/????-??-??_??-??-?? 2>/dev/null | sort | tail -1
  fi
}

# ─── Count Snapshots ─────────────────────────────────────────────
count_snapshots() {
  ls -1d "$BACKUP_DEST"/????-??-??_??-??-?? 2>/dev/null | wc -l
}

# ─── BACKUP ──────────────────────────────────────────────────────
do_backup() {
  load_config
  
  # Ensure backup destination exists
  mkdir -p "$BACKUP_DEST"
  
  # Concurrency protection via flock
  exec 200>"$LOCK_FILE"
  if ! flock -n 200; then
    log "ERROR: Another backup instance is running (lock held: $LOCK_FILE)"
    echo "LOCKED: Another backup instance is running"
    exit 1
  fi
  
  log "═══ BACKUP START ═══"
  local start_time=$(date +%s)
  local snapshot_name=$(date -u +"%Y-%m-%d_%H-%M-%S")
  local snapshot_path="$BACKUP_DEST/$snapshot_name"
  
  # Check disk space
  if ! check_disk_space; then
    local disk_free_bytes=$(df --output=avail -B1 "$BACKUP_DEST" 2>/dev/null | tail -1 | tr -d ' ')
    write_status "failure" "0" "$snapshot_name" "0" "0" "$(count_snapshots)" "0" "$disk_free_bytes" "Insufficient disk space"
    exit 1
  fi
  
  # Build exclude args
  local exclude_args=$(build_exclude_args)
  
  # Find latest snapshot for --link-dest (incremental)
  local link_dest_arg=""
  local latest=$(get_latest_snapshot)
  if [ -n "$latest" ] && [ -d "$latest" ]; then
    link_dest_arg="--link-dest=$latest"
    log "Incremental backup using link-dest: $latest"
  else
    log "Full backup (no previous snapshot found)"
  fi
  
  # Execute rsync
  log "Backing up $SOURCE_PATH -> $snapshot_path"
  local rsync_output
  rsync_output=$(eval rsync -a --delete $link_dest_arg $exclude_args '"$SOURCE_PATH/"' '"$snapshot_path/"' 2>&1)
  local rsync_exit=$?
  
  local end_time=$(date +%s)
  local duration=$((end_time - start_time))
  
  if [ $rsync_exit -eq 0 ]; then
    # Calculate sizes
    local size_bytes=$(du -sb "$snapshot_path" 2>/dev/null | cut -f1)
    local actual_disk=$(du -s --block-size=1 "$snapshot_path" 2>/dev/null | cut -f1)
    local disk_free_bytes=$(df --output=avail -B1 "$BACKUP_DEST" 2>/dev/null | tail -1 | tr -d ' ')
    
    # Run retention pruning
    local pruned=0
    pruned=$(do_prune_internal)
    
    local retained=$(count_snapshots)
    
    log "BACKUP SUCCESS: $snapshot_name (size: ${size_bytes}B, duration: ${duration}s, retained: $retained, pruned: $pruned)"
    write_status "success" "$duration" "$snapshot_name" "$size_bytes" "$actual_disk" "$retained" "$pruned" "$disk_free_bytes" "null"
    log "═══ BACKUP COMPLETE ═══"
    exit 0
  else
    log "BACKUP FAILED: rsync exit code $rsync_exit"
    log "rsync output: $rsync_output"
    local disk_free_bytes=$(df --output=avail -B1 "$BACKUP_DEST" 2>/dev/null | tail -1 | tr -d ' ')
    write_status "failure" "$duration" "$snapshot_name" "0" "0" "$(count_snapshots)" "0" "$disk_free_bytes" "rsync failed with exit code $rsync_exit"
    exit 1
  fi
}

# ─── PRUNE (internal, returns pruned count) ──────────────────────
do_prune_internal() {
  local snapshots=()
  local keep=()
  local pruned=0
  
  # Get all snapshots sorted oldest first
  while IFS= read -r snap; do
    [ -n "$snap" ] && snapshots+=("$snap")
  done < <(ls -1d "$BACKUP_DEST"/????-??-??_??-??-?? 2>/dev/null | sort)
  
  local total=${#snapshots[@]}
  if [ $total -eq 0 ]; then
    echo "0"
    return
  fi
  
  # Keep last N daily
  local daily_kept=0
  for ((i=total-1; i>=0 && daily_kept<RETAIN_DAILY; i--)); do
    keep+=("${snapshots[i]}")
    daily_kept=$((daily_kept + 1))
  done
  
  # Keep last M weekly (one per calendar week)
  local weekly_kept=0
  local last_week=""
  for ((i=total-1; i>=0 && weekly_kept<RETAIN_WEEKLY; i--)); do
    local snap_date=$(basename "${snapshots[i]}" | cut -d_ -f1)
    local week_num=$(date -d "$snap_date" +%Y-%W 2>/dev/null || echo "")
    if [ -n "$week_num" ] && [ "$week_num" != "$last_week" ]; then
      local already=0
      for k in "${keep[@]}"; do
        [ "$k" = "${snapshots[i]}" ] && already=1 && break
      done
      [ $already -eq 0 ] && keep+=("${snapshots[i]}")
      last_week="$week_num"
      weekly_kept=$((weekly_kept + 1))
    fi
  done
  
  # Keep last K monthly (one per calendar month)
  local monthly_kept=0
  local last_month=""
  for ((i=total-1; i>=0 && monthly_kept<RETAIN_MONTHLY; i--)); do
    local snap_date=$(basename "${snapshots[i]}" | cut -d_ -f1)
    local month_id=$(date -d "$snap_date" +%Y-%m 2>/dev/null || echo "")
    if [ -n "$month_id" ] && [ "$month_id" != "$last_month" ]; then
      local already=0
      for k in "${keep[@]}"; do
        [ "$k" = "${snapshots[i]}" ] && already=1 && break
      done
      [ $already -eq 0 ] && keep+=("${snapshots[i]}")
      last_month="$month_id"
      monthly_kept=$((monthly_kept + 1))
    fi
  done
  
  # Remove snapshots not in keep list
  for snap in "${snapshots[@]}"; do
    local should_keep=0
    for k in "${keep[@]}"; do
      [ "$k" = "$snap" ] && should_keep=1 && break
    done
    if [ $should_keep -eq 0 ]; then
      rm -rf "$snap"
      log "PRUNED: $(basename "$snap")"
      pruned=$((pruned + 1))
    fi
  done
  
  echo "$pruned"
}

# ─── PRUNE (standalone command) ──────────────────────────────────
do_prune() {
  load_config
  log "═══ PRUNE START ═══"
  local pruned=$(do_prune_internal)
  local retained=$(count_snapshots)
  log "PRUNE COMPLETE: $pruned removed, $retained retained"
  log "═══ PRUNE COMPLETE ═══"
}

# ─── LIST ─────────────────────────────────────────────────────────
do_list() {
  load_config
  local json_mode=0
  [ "${1:-}" = "--json" ] && json_mode=1
  
  local snapshots=()
  while IFS= read -r snap; do
    [ -n "$snap" ] && snapshots+=("$snap")
  done < <(ls -1d "$BACKUP_DEST"/????-??-??_??-??-?? 2>/dev/null | sort)
  
  if [ ${#snapshots[@]} -eq 0 ]; then
    if [ $json_mode -eq 1 ]; then
      echo "[]"
    else
      echo "No snapshots found."
    fi
    return
  fi
  
  if [ $json_mode -eq 1 ]; then
    # Build JSON array using node
    local snap_list=""
    for snap in "${snapshots[@]}"; do
      snap_list="$snap_list$snap|"
    done
    node -e "
      const paths = process.argv[1].split('|').filter(Boolean);
      const fs = require('fs');
      const path = require('path');
      const snaps = paths.map(s => {
        const name = path.basename(s);
        try {
          const du = require('child_process').execSync('du -sb ' + s + ' 2>/dev/null', {encoding:'utf-8'});
          const sizeBytes = parseInt(du.split('\t')[0]) || 0;
          return { name, path: s, size_bytes: sizeBytes };
        } catch(e) {
          return { name, path: s, size_bytes: 0 };
        }
      });
      console.log(JSON.stringify(snaps, null, 2));
    " "$snap_list"
  else
    printf "%-25s %s\n" "SNAPSHOT" "PATH"
    printf "%-25s %s\n" "--------" "----"
    for snap in "${snapshots[@]}"; do
      printf "%-25s %s\n" "$(basename "$snap")" "$snap"
    done
    echo ""
    echo "Total: ${#snapshots[@]} snapshot(s)"
  fi
}

# ─── RESTORE ─────────────────────────────────────────────────────
do_restore() {
  load_config
  local snapshot_name="${1:-}"
  local target_path="${2:-$SOURCE_PATH}"
  local confirm="${3:-}"
  
  if [ -z "$snapshot_name" ]; then
    echo "Available snapshots:"
    do_list
    echo ""
    echo "Usage: backup.sh restore <snapshot_name> [target_path] --confirm"
    return 1
  fi
  
  local snapshot_path="$BACKUP_DEST/$snapshot_name"
  if [ ! -d "$snapshot_path" ]; then
    echo "ERROR: Snapshot not found: $snapshot_path"
    return 1
  fi
  
  # Handle --confirm as 2nd or 3rd arg
  if [ "$confirm" != "--confirm" ] && [ "${2:-}" != "--confirm" ]; then
    echo "WARNING: This will restore snapshot '$snapshot_name' to '$target_path'"
    echo "Add --confirm flag to proceed"
    return 1
  fi
  
  if [ "${2:-}" = "--confirm" ]; then
    target_path="$SOURCE_PATH"
  fi
  
  log "═══ RESTORE START ═══"
  log "Restoring $snapshot_name -> $target_path"
  
  mkdir -p "$target_path"
  rsync -a --delete "$snapshot_path/" "$target_path/"
  local exit_code=$?
  
  if [ $exit_code -eq 0 ]; then
    log "RESTORE SUCCESS: $snapshot_name -> $target_path"
  else
    log "RESTORE FAILED: rsync exit code $exit_code"
  fi
  log "═══ RESTORE COMPLETE ═══"
  return $exit_code
}

# ─── VERIFY ──────────────────────────────────────────────────────
do_verify() {
  load_config
  log "═══ VERIFY START ═══"
  
  # Create sentinel file with known content
  local sentinel_content="AXIOM-BACKUP-VERIFY-$(date +%s)-$RANDOM"
  local sentinel_hash=$(echo -n "$sentinel_content" | md5sum | cut -d' ' -f1)
  local sentinel_file="$SOURCE_PATH/.axiom-backup-verify-sentinel"
  
  echo -n "$sentinel_content" > "$sentinel_file"
  log "Created sentinel file with hash: $sentinel_hash"
  
  # Run a backup (without exclude patterns so sentinel is captured)
  mkdir -p "$BACKUP_DEST"
  local snapshot_name="verify-$(date -u +"%Y-%m-%d_%H-%M-%S")"
  local snapshot_path="$BACKUP_DEST/$snapshot_name"
  
  local latest=$(get_latest_snapshot)
  local link_dest_arg=""
  [ -n "$latest" ] && [ -d "$latest" ] && link_dest_arg="--link-dest=$latest"
  
  # Note: verify does NOT use exclude patterns to ensure sentinel gets backed up
  rsync -a --delete $link_dest_arg "$SOURCE_PATH/" "$snapshot_path/" 2>&1
  
  if [ $? -ne 0 ]; then
    log "VERIFY FAILED: backup step failed"
    rm -f "$sentinel_file"
    echo "FAIL — backup step failed"
    return 1
  fi
  
  # Check restored sentinel
  if [ -f "$snapshot_path/.axiom-backup-verify-sentinel" ]; then
    local restored_hash=$(md5sum "$snapshot_path/.axiom-backup-verify-sentinel" | cut -d' ' -f1)
    
    if [ "$sentinel_hash" = "$restored_hash" ]; then
      log "VERIFY PASS: sentinel hash matches ($sentinel_hash)"
      echo "PASS — sentinel file restored and hash matches ($sentinel_hash)"
      rm -f "$sentinel_file"
      rm -rf "$snapshot_path"
      log "═══ VERIFY COMPLETE ═══"
      return 0
    else
      log "VERIFY FAIL: hash mismatch (expected $sentinel_hash, got $restored_hash)"
      echo "FAIL — hash mismatch"
      rm -f "$sentinel_file"
      rm -rf "$snapshot_path"
      return 1
    fi
  else
    log "VERIFY FAIL: sentinel file not found in backup"
    echo "FAIL — sentinel file not found in backup snapshot"
    rm -f "$sentinel_file"
    rm -rf "$snapshot_path"
    return 1
  fi
}

# ─── STATUS ──────────────────────────────────────────────────────
do_status() {
  load_config
  if [ -f "$STATUS_FILE" ]; then
    cat "$STATUS_FILE"
  else
    echo '{"lastRun": null, "result": "never_run", "error": "No backup has been executed yet"}'
  fi
}

# ─── MAIN ────────────────────────────────────────────────────────
case "${1:-backup}" in
  backup)   do_backup ;;
  restore)  do_restore "${2:-}" "${3:-}" "${4:-}" ;;
  list)     do_list "${2:-}" ;;
  prune)    do_prune ;;
  verify)   do_verify ;;
  status)   do_status ;;
  *)
    echo "AXIOM v2 SP-Backup"
    echo "Usage: backup.sh {backup|restore|list|prune|verify|status}"
    echo ""
    echo "  backup   - Create incremental snapshot (default)"
    echo "  restore  - Restore from snapshot"
    echo "  list     - List available snapshots"
    echo "  prune    - Apply retention policy"
    echo "  verify   - Test backup/restore integrity"
    echo "  status   - Show last backup status"
    exit 1
    ;;
esac
