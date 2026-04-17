# VAULT: Go Live — Real Money Checklist (v2)

Status: **BLOCKED** — safeguards in flight after 15 Mar $50 loss.
Date started: 2026-03-13 (v1). Revised: 2026-04-17 (v2 post-incident).

See [lessons.md](./lessons.md) for the full post-mortem of the 15 March loss. This checklist is the "never again" operational procedure derived from it.

---

## Pre-flight: ALL boxes must be ticked before flipping `simulated: false`

### Code gates (automated — `vault verify-live` must exit 0)
- [ ] CLOB client signs a dummy message successfully
- [ ] On-chain USDC balance fetched via at least one RPC provider
- [ ] CTF + collateral allowances set (`check_allowances` returns non-zero)
- [ ] Zero open predictions with `execution_mode='real'` from a previous life (or each is verifiable on-chain)
- [ ] `compute_expected_onchain()` equals `get_usdc_balance()` within $0.50
- [ ] Multi-provider RPC fallback list has ≥ 2 working providers
- [ ] Daemon NOT currently running

### Tests (all must pass)
- [ ] `pytest projects/VAULT/tests/` returns 0 failures
- [ ] Key integration tests green: `test_bet_atomicity`, `test_rpc_failure`, `test_ledger_reset_on_golive`

### Wallet hygiene
- [ ] **Fresh Polymarket wallet** (not the one used in the March incident)
- [ ] Private key stored in VPS `.env`, file mode 600
- [ ] Funder address matches wallet — spot-checked in `vault setup-clob` output
- [ ] Allowances set on the fresh wallet (`vault setup-clob` run once)

### Procedural
- [ ] `tasks/lessons.md` reviewed in current session
- [ ] No unrelated work-in-progress in `projects/VAULT/` git (`git status` clean)
- [ ] Deploy happened within last 24h (ensures no stale code)
- [ ] Dashboard reachable and showing correct reconciliation state (`/api/v1/status` includes balance drift)

---

## Step 1 — Fund the fresh wallet

### Exchange setup
- [ ] Coinbase account funded
- [ ] Withdraw $50 USDC on **Polygon** network (NOT Ethereum — different gas, different bridge)
- [ ] Confirm arrival on Polygon via Polymarket UI (Helsinki proxy needed from UK)

### Helsinki proxy (for Polymarket access)
```bash
# WSL terminal — open tunnel
ssh -D 0.0.0.0:1080 -N -p 8443 hq@89.167.4.126

# PowerShell — launch Edge through proxy
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --proxy-server="socks5://127.0.0.1:1080"
```

---

## Step 2 — Go live (code-gated)

```bash
ssh hq@89.167.4.126
cd /home/hq/vault

# 1. Verify every pre-flight gate passes
.venv/bin/vault verify-live
# Must print: "✓ ALL CHECKS PASSED" and exit 0.
# If any red line, STOP. Fix the underlying issue. Re-run.

# 2. Execute go-live (zeros paper ledger, seeds with on-chain USDC)
.venv/bin/vault go-live
# You will be prompted to confirm the on-chain USDC amount.
# The command writes a `go_live` event to the DB — this is what `start` looks for.

# 3. Flip config
nano config.yaml     # set trading.simulated: false

# 4. Start daemon
.venv/bin/vault stop      # if running
.venv/bin/vault start     # fresh start — refuses to run in real mode without a go_live event
```

Startup log must show:
- `CLOB client ready. On-chain USDC: $XX.XX`
- `DRY-RUN MODE: first 20 cycles will log-only (no real orders)` (raised from 5 post-incident)
- `Real mode verified: go_live event XXXX, balance $XX.XX`

---

## Step 3 — Monitor first 48h

```bash
# Watch logs for [REAL] tags and any CRITICAL lines
ssh hq@89.167.4.126 "journalctl -u vault-daemon -f | grep -E 'REAL|CRITICAL|divergence|orphan|pause'"

# Check predictions table for pending/reconciling rows
ssh hq@89.167.4.126 "cd /home/hq/vault && sqlite3 vault.db 'SELECT status, execution_mode, COUNT(*) FROM predictions GROUP BY status, execution_mode'"

# Dashboard "Balance Reconciliation" panel should show drift ≤ $0.50
```

### Red flags — HALT immediately
- Any `status='pending'` prediction older than 10 minutes
- Any `status='reconciling'` prediction (means orphan sweep found on-chain position without matching DB row)
- `Negative balance drift` WARNING with `not auto-adjusting` — should never appear post-fix
- `Balance divergence check failed: RPC unavailable` more than 3x in a row
- Any `CLOB order failed: invalid signature` — allowance or private-key issue, not a retry scenario

### Emergency rollback
```bash
ssh hq@89.167.4.126 "cd /home/hq/vault && .venv/bin/vault pause"
# Investigate. Do NOT resume until root cause identified.
# If the pause was triggered by divergence, DO NOT manually resume —
# the code paused for a reason, and manual override voids the safety.
```

---

## Config Reference (real-mode)

VPS `.env`:
```
POLYMARKET_PRIVATE_KEY=0x...     # fresh wallet
POLYMARKET_FUNDER_ADDRESS=0x...  # matches private key
```

VPS `config.yaml`:
```yaml
trading:
  simulated: false
  clob:
    slippage_pct: 0.02
    fallback_on_failure: skip
    dry_run_startup_cycles: 20             # raised from 5 after March incident
    balance_divergence_tolerance: 0.50     # tightened from 1.00
    reconcile_interval_cycles: 10
    orphan_sweep_interval_cycles: 30
    max_bet_pct_onchain: 0.10              # max 10% of on-chain USDC per bet
    rpc_fallback:
      - "https://polygon-bor-rpc.publicnode.com"
      - "https://polygon.drpc.org"
      - "https://polygon-rpc.com"
    rpc_failure_pause_threshold: 3         # auto-pause after N consecutive None returns
```
