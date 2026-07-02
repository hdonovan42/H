# Task: P0 reliability fixes (from architecture-audit-2026-07-02.md)

Four silent-loss/reliability fixes. Root causes found in code review:
- The 48.5 h outage class: cron `flock -n` supervision is brittle (stale-lock no-op).
- 5,916 `database is locked` errors: digest `bank()`/`audit()` hold ONE write txn across slow
  work (file copies per id; ~0.35 s model predict per stale row in audit) while the loop tries
  to write with only a 10 s busy_timeout.
- `wn_safe` failure → wn_scored=0 rows are invisible to review AND pruned at 7 d, with no alarm.
- `auto_bank()` banks then emails without checking the send; `check_loop_health` arms its
  3 h throttle marker even when the alarm email failed.

## Plan
- [x] **Fix 1 — systemd supervision**: new `deploy/waymowatch-loop.service` (User=hq, Restart=always,
      RestartSec=30, Nice=10, OMP/MKL=2, stdout append to capture.log). Rewrite `run_watch.sh` as
      watchdog-only (heartbeat >600 s → pkill; systemd respawns). No flock anywhere.
- [x] **Fix 2 — scoring-health**: in `check_loop_health`, alarm if ≥10 candidates captured in the
      last 2 h have `COALESCE(wn_scored,0)=0` (own marker, 3 h throttle, marker only on send OK).
      In `retention()`, never prune `wn_scored=0` rows (add `AND COALESCE(wn_scored,0)=1`).
- [x] **Fix 3 — email ordering**: `auto_bank()` sends the sheet FIRST, banks only on send success
      (failure → rows stay eligible, next midnight retries). `check_loop_health` stall marker
      written only when `send_email` returns True. Stall-email remediation text → systemd.
- [x] **Fix 4 — DB contention**: `db_connect` busy_timeout 10 s → 60 s; `bank()` and `audit()`
      commit per row (short write txns — file copies/predicts no longer inside a txn).
- [x] Rider (P1, same file+restart): remove the dead per-cycle `review_sheet(con)` call (:876).
- [x] CHANGELOG entry + commit + push (main).
- [x] Deploy: rsync 4 collector files; root: install unit, daemon-reload, enable; bracket-pkill
      loop; systemctl start; verify (is-active, etimes, cycle lines, candidates flowing,
      digest --dry-run smoke test).

## Review
DONE + deployed + verified live (2026-07-02 ~13:00 UTC):
- Unit enabled + started; **kill test passed** — pkill'd the loop, systemd respawned in ~30 s
  (`NRestarts=1`), vs the old cron+flock path that failed to restart for 48.5 h in June.
- First systemd cycle clean: `600 polled | processed 42 | dropped 0 | +1 new` (small catch-up,
  as expected after the ~2 min cutover gap).
- `waymonet_digest.py --dry-run` smoke test OK — new scoring-health SQL ran (healthy: 0 unscored),
  digest path intact.
- Syntax-checked all edited files; deployed via rsync (no hand-edits on the VPS).
- Watch next: `database is locked` lines should stop appearing in capture.log (root cause = long
  digest/audit write txns, now per-row commits + 60 s busy_timeout); tonight's 00:00 auto-bank
  should behave identically (send-first ordering only changes the failure path).
