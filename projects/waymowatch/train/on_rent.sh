#!/usr/bin/env bash
# WaymoNet ON-RENT RAMP — one command from "instance running" to "GPU training".
# Run FROM THE VPS (the data lives here; Hetzner uplink moves ~5 GB in ~3 min vs ~2 h from
# home broadband — measured RUN_3). Everything on-clock is this script; if it exits 0 the
# GPU is spinning and the only remaining section-B steps are the gates after training.
#
#   bash train/on_rent.sh <ssh_port> <ip> [run_name]        e.g. 27978 84.2.12.77 waymonet_real_v4
#
# Prereqs (section A, off the clock): /tmp/waymonet_train.tgz, /tmp/cand_frames.tgz,
# /tmp/run3_manifest.csv built; the VPS pubkey on the Vast ACCOUNT (Account -> SSH Keys).
# If auth fails: add the account key OR append via another authorised machine and rerun
# IMMEDIATELY (Vast periodically rewrites authorized_keys — established connections survive).
set -euo pipefail
PORT=${1:?usage: on_rent.sh <ssh_port> <ip> [run_name]}
IP=${2:?usage: on_rent.sh <ssh_port> <ip> [run_name]}
NAME=${3:-waymonet_real_v3}
GPU="root@$IP"
SSHO="-o StrictHostKeyChecking=accept-new -p $PORT"
cd "$(dirname "$(readlink -f "$0")")/.."

for f in /tmp/waymonet_train.tgz /tmp/cand_frames.tgz /tmp/run3_manifest.csv; do
  [ -f "$f" ] || { echo "MISSING $f — run section A (build + tar) first"; exit 1; }
done

echo "[1/4] push (bundle + manifest + warm-start weights + frames)…"
scp $SSHO /tmp/waymonet_train.tgz /tmp/run3_manifest.csv collector/best.pt /tmp/cand_frames.tgz "$GPU:/workspace/"

echo "[2/4] extract + pinned deps…"
ssh $SSHO "$GPU" "cd /workspace && tar xzf waymonet_train.tgz && tar xzf cand_frames.tgz \
  && rm -f /workspace/*.tgz && /venv/main/bin/pip install -q 'ultralytics==8.4.63'"

echo "[3/4] launch $NAME (warm-start; epochs/close_mosaic/workers = train.py defaults)…"
ssh $SSHO "$GPU" "cd /workspace && nohup /venv/main/bin/python /workspace/train/train.py \
  --model /workspace/best.pt --name $NAME --device 0 > /workspace/train.log 2>&1 & echo launched"

echo "[4/4] verify (45 s warmup)…"
sleep 45
ssh $SSHO "$GPU" "nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader; \
  tr '\r' '\n' < /workspace/train.log | grep -vE '^\s*\$' | tail -3"
echo "RAMP DONE — GPU is training. Monitor: tr '\\r' '\\n' < /workspace/train.log | tail"
