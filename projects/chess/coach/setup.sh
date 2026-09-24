#!/usr/bin/env bash
# Make this machine a coach worker: Python venv with python-chess, and the
# official Stockfish 19 binary for this CPU. Safe to run again.
#
#   ./setup.sh                     install
#   ./setup.sh --cron              also print the crontab line to schedule it
#
# Then hand over the analysed backlog from the machine that has it, once:
#   rsync -a <that machine>:<path>/projects/chess/coach/data/ data/
# (or let this one recompute it: results are identical on any machine).
set -euo pipefail
cd "$(dirname "$0")"

python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip "chess>=1.11"

if [ ! -x bin/stockfish19 ]; then
  case "$(uname -m)" in
    x86_64) build=stockfish-linux-x86-64-universal ;;
    aarch64 | arm64) build=stockfish-linux-arm64-universal ;;
    *) echo "no Stockfish 19 build for $(uname -m); set COACH_STOCKFISH to a binary" >&2; exit 1 ;;
  esac
  mkdir -p bin
  curl -sL "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/$build.tar.gz" | tar xz -C bin
  mv "bin/stockfish/$build" bin/stockfish19
  mv bin/stockfish/Copying.txt bin/stockfish-COPYING.txt
  rm -rf bin/stockfish
fi
printf 'uci\nquit\n' | bin/stockfish19 | grep -q "id name Stockfish 19" && echo "Stockfish 19 ready"
.venv/bin/python tests/test_lichess.py
.venv/bin/python tests/test_motifs.py
.venv/bin/python coach.py status

if [ "${1:-}" = "--cron" ]; then
  echo
  echo "Add with 'crontab -e': every 30 minutes, fetch, analyse (low priority, 2 workers), rebuild, publish"
  echo "*/30 * * * * cd $PWD && .venv/bin/python coach.py update --workers 2 --publish >> data/update.log 2>&1"
fi
