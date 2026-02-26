---
name: vault
description: Load full VAULT project context for working on the autonomous Polymarket trading agent.
argument-hint: [task description]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, WebFetch, WebSearch
---

# VAULT — Autonomous Polymarket Momentum Agent

Load context and begin working on the VAULT project. If arguments are provided, carry out that task. Otherwise, check live status and ask what to work on.

## Project Overview

VAULT is an autonomous persistent AI financial agent that fights to survive on a $50 seed balance. It trades prediction markets on Polymarket using momentum/velocity signals. Python + SQLite + Click CLI + systemd daemon.

- **Repo path**: `projects/VAULT/`
- **VPS**: `89.167.4.126`, user `hq`, systemd services `vault-daemon` + `vault-api`
- **Dashboard**: https://vault.hjd.ai (FastAPI on port 3200)
- **Deploy**: `cd projects/VAULT && bash deploy/deploy.sh`

## Architecture

### Pipeline (momentum-only mode since v13.5)

```
daemon loop (60s) → run_cycle()
  ├── resolve settled predictions
  ├── exit sweep (5 exit functions)
  ├── pipeline:
  │   ├── market discovery (top 500 Polymarket markets, >$10k volume)
  │   └── edge calculation (velocity: v_1h, v_6h, z-score)
  ├── momentum analysis (pre-filters → Haiku validation → sizing)
  └── execution (best candidate by signal strength * confidence)
```

### Key Files

| File | Purpose |
|------|---------|
| `vault/agent.py` | **The brain** — `run_cycle()` orchestrates everything (~1250 lines) |
| `vault/pipeline.py` | Pipeline orchestrator. Phases 1-2 skipped (momentum-only) |
| `vault/edge_calculator.py` | Velocity calculation, Kelly sizing, smart money (~600 lines) |
| `vault/claude_client.py` | Anthropic SDK wrapper, every call deducts from balance |
| `vault/db.py` | SQLite schema v14, 18 tables, migrations |
| `vault/ledger.py` | Unified balance — seed + API costs + trading P&L |
| `vault/prompts.py` | System prompt + momentum validation prompt for Haiku |
| `vault/market_discovery.py` | Polymarket bulk fetch, volume tracking, odds snapshots |
| `vault/polymarket.py` | Gamma API client |
| `vault/guardrails.py` | Death condition (balance <= $0), trade limits, resurrect |
| `vault/estimator.py` | Independent probability estimation (currently disabled) |
| `vault/intelligence.py` | Opus master intelligence doc (currently disabled) |
| `vault/sentinel.py` | Haiku thesis monitor (currently disabled) |
| `vault/api.py` | FastAPI dashboard API (18 endpoints, port 3200) |
| `vault/cli.py` | Click CLI — start/stop/kill/status/logs/report/history/pause/resume/api |
| `vault/actuators/` | bet, hold, wait, sell_prediction, research_markets |
| `config/default.yaml` | All configuration: pricing, velocity thresholds, sizing, exits |
| `dashboard/` | React + Vite dashboard (vault.hjd.ai) |
| `deploy/deploy.sh` | Full deploy: build dashboard, rsync, pip install, systemd restart |
| `CHANGELOG.md` | Algorithm changelog (v1 through current) |

### Database (SQLite, schema v14)

Key tables: `cycles`, `predictions`, `ledger`, `musk_markets`, `odds_snapshots`, `smart_money_log`, `api_calls`, `objectives`, `events`, `memory`

### Momentum Entry Logic (in `agent.py`)

1. **Pre-filters** (all $0, no API calls): skip noisy types, check odds/spread/liquidity, mechanical direction from v_1h sign, velocity thresholds, exposure/position caps, opposite-side guard, multi-flip guard
2. **Position-aware validation**: existing same-side = skip Haiku (synthetic 0.8 confidence); new entry = smart routing (auto-follow clear signals, Haiku only when risk triggers fire)
3. **Haiku validation**: binary follow/no-follow with confidence score
4. **Sizing**: base 2.5% of total value, velocity-scaled (1.5x at 20%, 2x at 40%), pyramiding multipliers, capped at 10%

### Exit Logic (5 exit functions)

1. `_exit_substandard_positions` — close below entry minimums
2. `_exit_opportunity_cost` — remaining return < risk-free rate
3. `_exit_momentum_reversal` — velocity flipped against position
4. `_exit_trailing_stop` — ROI dropped 15pp from peak
5. `_exit_stale_momentum` — momentum has stalled

## Initial Status Check

When this skill is invoked, ALWAYS run these first to establish current state:

```bash
# Check if daemon is alive and recent cycle
ssh hq@89.167.4.126 "cd /home/hq/vault && .venv/bin/vault status 2>&1; echo '---RECENT-CYCLES---'; .venv/bin/vault logs -n 3 2>&1"
```

```bash
# Check API server health
ssh hq@89.167.4.126 "curl -s localhost:3200/api/v1/status | python3 -m json.tool 2>&1"
```

Report the current state to the user: alive/dead/paused, balance, runway, recent actions, any errors.

## Common Operations

### Check VPS logs
```bash
ssh hq@89.167.4.126 "journalctl -u vault-daemon --no-pager -n 50 --since '1 hour ago'"
```

### Check dashboard API logs
```bash
ssh hq@89.167.4.126 "journalctl -u vault-api --no-pager -n 20"
```

### Query the database directly
```bash
ssh hq@89.167.4.126 "cd /home/hq/vault && sqlite3 vault.db '<SQL>'"
```

### Restart services (use root)
```bash
ssh root@89.167.4.126 "systemctl restart vault-daemon vault-api"
```

### Deploy
```bash
cd projects/VAULT && bash deploy/deploy.sh
```

## Rules

- **Never hand-fix on VPS** — if the pipeline produces buggy code, fix the prompts/code locally and redeploy
- **Death is permanent** — balance <= $0 means daemon stops. Only `vault start --resurrect` resets to $50
- **Haiku is default model** — every API call costs real money from the balance. Minimize calls
- **Test locally first** — `cd projects/VAULT && python -m vault status` works locally with a local vault.db
- After any code changes, use `/dcp VAULT` to deploy, commit, and push

## Task

$ARGUMENTS
