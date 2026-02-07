# SP-Backup: Automated Incremental Workspace Backup

**Value Category:** Self-Preservation  
**Version:** 1.0.0  
**Status:** Active

## Overview

SP-Backup creates automated, space-efficient incremental backups of the AXIOM v2 workspace using rsync with hard-link snapshots. Each backup appears as a full copy of the workspace, but only changed files consume additional disk space.

## Architecture

```
┌─────────────────┐     rsync --link-dest     ┌──────────────────────┐
│  /home/hq/axiom2│ ─────────────────────────► │  /var/backups/axiom  │
│  (source)       │                            │  ├── 2025-02-07_...  │
│                 │                            │  ├── 2025-02-08_...  │
│                 │                            │  ├── status.json     │
│                 │                            │  └── backup.log      │
└─────────────────┘                            └──────────────────────┘
```

### Hard-Link Snapshots

Each snapshot directory contains a complete directory tree mirroring the source. Files unchanged between snapshots share the same inode (hard link), so a workspace with 100MB of data and 1MB of daily changes costs ~101MB for the first backup and ~1MB per subsequent backup.

### Components

| File | Purpose |
|------|---------|
| `backup.sh` | Main backup script with all operations |
| `config.json` | Configuration (paths, retention, thresholds) |
| `capability.json` | AXIOM v2 module manifest |
| `axiom-backup.service` | systemd service unit |
| `axiom-backup.timer` | systemd timer (daily 03:00 UTC) |
| `install.sh` | Installation and setup script |

## Usage

### Manual Backup
```bash
./backup.sh backup
```

### List Snapshots
```bash
./backup.sh list          # Human-readable table
./backup.sh list --json   # JSON output for monitoring
```

### Restore
```bash
# List available snapshots
./backup.sh restore

# Restore specific snapshot to original location
./backup.sh restore 2025-02-07_03-00-00 --confirm

# Restore to alternate location
./backup.sh restore 2025-02-07_03-00-00 /tmp/restore-test --confirm
```

### Verify Integrity
```bash
./backup.sh verify
# Creates a sentinel file, backs it up, verifies hash match
```

### Check Status
```bash
./backup.sh status
# Returns JSON with last run details, used by sp-monitoring
```

### Manual Prune
```bash
./backup.sh prune
# Applies retention policy (normally runs automatically after each backup)
```

## Configuration

Edit `config.json`:

```json
{
  "source_paths": ["/home/hq/axiom2"],
  "backup_dest": "/var/backups/axiom",
  "exclude_patterns": ["node_modules", ".git/objects", "*.log", "tmp/"],
  "retention": {"daily": 7, "weekly": 4, "monthly": 3},
  "disk_free_threshold_mb": 500,
  "log_file": "/var/backups/axiom/backup.log",
  "status_file": "/var/backups/axiom/status.json",
  "lock_file": "/tmp/axiom-backup.lock"
}
```

### Retention Policy

- **Daily:** Keep last 7 snapshots (one per day)
- **Weekly:** Keep last 4 weekly snapshots (one per calendar week)
- **Monthly:** Keep last 3 monthly snapshots (one per calendar month)

Overlapping categories don't duplicate — a snapshot can satisfy daily AND weekly retention simultaneously.

### Exclusions

Default exclusions keep backups lean:
- `node_modules` — Reproducible from package-lock.json
- `.git/objects` — Large binary objects, reproducible via git fetch
- `*.log` — Transient log files
- `tmp/` — Temporary files

## Integration with sp-monitoring

The `status.json` file is the integration point:

```json
{
  "lastRun": "2025-02-07T03:00:15.123Z",
  "result": "success",
  "duration_seconds": 12,
  "snapshot": "2025-02-07_03-00-03",
  "size_bytes": 5242880,
  "transferred_bytes": 1048576,
  "snapshots_retained": 7,
  "snapshots_pruned": 1,
  "disk_free_bytes": 67645734912,
  "error": null
}
```

sp-monitoring can poll this file to alert on:
- `result !== "success"` → Backup failure
- `duration_seconds` spikes → Performance degradation
- `disk_free_bytes` dropping → Disk pressure
- `lastRun` age > 25 hours → Missed backup

## Concurrency Protection

Uses `flock` on `/tmp/axiom-backup.lock` to prevent overlapping backup runs. If a second instance tries to start while one is running, it exits immediately with a clear message.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Another backup instance is running" | Wait for current backup to finish, or remove lock file |
| "Insufficient disk space" | Free disk space or reduce retention in config.json |
| "Config file not found" | Ensure config.json is in same directory as backup.sh |
| Slow backups | Check exclude_patterns — node_modules and .git/objects should be excluded |
| Restore fails | Verify snapshot exists with `./backup.sh list` |

## Security Notes

- Backups are on the same disk (single VPS constraint) — protects against accidental deletion and bad deployments, NOT disk failure
- No encryption (local backups on same machine) — future enhancement for offsite backups
- Lock file prevents race conditions
- Status writes are atomic (tmp file + mv) to prevent corrupt reads
