# Safeguard Backtester Implementation

## Completed
- [x] `vault/db.py` — Schema v16: `backtest_results` table + migration
- [x] `vault/backtester.py` — Core module: 5 safeguard simulators + Welch's t-test + Cohen's d
- [x] `vault/cli.py` — `vault backtest [--days N]` command
- [x] `vault/agent.py` — Weekly trigger (every 10,080 cycles)
- [x] `vault/api.py` — `/api/v1/backtest/latest` endpoint
- [x] `config/default.yaml` — `backtest_interval_cycles: 10080`
- [x] Deployed to VPS and verified against 498 live trades
- [x] Services restarted (daemon + API)

## First Run Results (498 momentum trades)

| Safeguard | Param | Blocked | Impact | p-value | Significant |
|-----------|-------|---------|--------|---------|-------------|
| Weather filter | on | 18 (8W/10L) | +$9.66 | 0.0223 | **YES** |
| Min volume | $5K | 13 (1W/12L) | +$19.50 | 0.0007 | **YES** |
| Min volume | $10K | 159 (97W/62L) | -$36.97 | 0.0264 | YES (negative) |
| Add cooldown | 10m | 270 | -$20.63 | 0.5144 | No |
| Add ROI floor | 2% | 155 | -$12.57 | 0.6353 | No |
| Max positions | 3 | 163 | -$5.36 | 0.9042 | No |

### Key Findings
- **Weather filter already significant** — saves $9.66, blocks 10 losses vs 8 wins
- **$5K volume floor highly significant** — blocks 12/13 losers, saves $19.50
- **$10K+ volume floor harmful** — blocks too many profitable trades
- **Add cooldown not significant** — blocks proportionally equal W/L (needs more data)
- **ROI floor / max positions** — not significant, may never reach it
