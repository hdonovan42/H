#!/usr/bin/env bash
# WaymoWatch — hourly backup of all scored candidates to github.com/hdonovan42/waymo (private).
# APPEND-ONLY: candidate jpgs are write-once on the VPS but perishable (7-day retention prune,
# best-view dedup deletes superseded views) — the repo keeps everything the VPS later discards.
# rsync --ignore-existing + no --delete is what makes that true; never "fix" either flag.
# candidates.csv/cameras.csv are full snapshots each run (no emb column — embeddings are
# recomputable from the crop jpgs with the committed MobileNetV3 code).
# Cron: 37 * * * * /home/hq/waymowatch/collector/backup_github.sh >> /home/hq/waymowatch/data/backup.log 2>&1
# Pushes over the github-waymo ssh alias (deploy key id_ed25519_waymo, write access).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
REPO="${REPO:-/home/hq/waymo-backup}"

exec 9>/tmp/waymowatch-backup.lock
flock -n 9 || { echo "$(date -u +%FT%TZ) backup already running — skipped"; exit 0; }

mkdir -p "$REPO/images/candidates" "$REPO/images/real_positives"
# only candidate jpgs: skip transient composites (*sheet*.jpg) and non-jpg files
# (capture.log, heartbeat) that share data/candidates/
rsync -a --ignore-existing --exclude='*sheet*.jpg' --include='*.jpg' --exclude='*' \
      data/candidates/ "$REPO/images/candidates/"
rsync -a data/real_positives/ "$REPO/images/real_positives/"

ROWS=$(REPO="$REPO" .venv/bin/python - <<'EOF'
import csv, os, sqlite3
repo = os.environ["REPO"]
con = sqlite3.connect("data/waymo.db", timeout=60)
rows = con.execute(
    "SELECT id,camera_id,captured_at,score,status,crop_path,frame_path,bbox,alerted,sent "
    "FROM candidates ORDER BY id").fetchall()
with open(os.path.join(repo, "candidates.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["id", "camera_id", "captured_at", "score", "status",
                "crop", "frame", "bbox", "alerted", "sent"])
    for r in rows:
        r = list(r)
        r[5] = os.path.basename(r[5] or "")
        r[6] = os.path.basename(r[6] or "")
        w.writerow(r)
with open(os.path.join(repo, "cameras.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["id", "short_id", "common_name", "view", "lat", "lon"])
    w.writerows(con.execute(
        "SELECT id,short_id,common_name,view,lat,lon FROM cameras ORDER BY id"))
print(len(rows))
EOF
)

cd "$REPO"
git add -A
if git diff --cached --quiet; then
    echo "$(date -u +%FT%TZ) no changes"
    exit 0
fi
FILES=$(find images -name '*.jpg' | wc -l)
git commit -qm "backup $(date -u +%FT%TZ): ${ROWS} rows, ${FILES} jpgs"
git push -q origin main
echo "$(date -u +%FT%TZ) pushed: ${ROWS} rows, ${FILES} jpgs"
