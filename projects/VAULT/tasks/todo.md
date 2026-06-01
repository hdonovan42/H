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

---

# Live-vs-Paper Investigation (1 Jun 2026)

Balance $18.38 (from ~$27 capital in: $12.67 seed + ~$14 deposits). Realised
trading P&L −$8.01 on 72 closed trades. Paper was profitable; live reversed.

## Findings (noted for later)
- **Negative edge on fills**: 72 closed = 42% win, avg loss (−$0.468) > avg win
  (+$0.389) → −$0.11/trade. Velocity is a lagging signal (buy the top).
- **Adverse selection**: 95 highest-conviction "clear signal" bets were CANCELLED
  (pending, never fill-verified) in go-live weeks. Paper counts these as wins.
- **Paper ignored costs**: recurring `balance_divergence` (on-chain < ledger),
  circuit breakers. Shadow (paper) trades also losing → edge eroded.
- **Favourite-chasing is the biggest leak**: 0.95–0.99 bucket −$4.08 / 6 trades;
  rejecting >0.85 → loss −$8.01 ⇒ −$2.53 (+$5.48).

## Action items
- [x] **#3 FIX — `market_discovery.py` `page=500`→`100`.** Deployed v21.0 (1 Jun 2026).
      Post-deploy: 2000 scanned / 391 tracked (was 100/27). Trades resume ~1h after
      deploy once snapshot history rebuilds.
- [x] **#1 odds cap** — `agent.py` 0.995 → config `velocity.momentum_max_entry_odds: 0.90`.
      Deployed v21.0. Retro +$4.18 (≥0.90) / +$5.48 (≥0.85).
- [x] **`momentum_min_volume` 500 → 5000** — deployed v21.0 (backtester +$19.50).
- [x] **odds_snapshots index** — schema v23 `idx_odds_snapshots_market_ts`; was missing
      on live DB (v14 migration skipped by 24 Apr reset). Cut cycle 19s→1.8s.
- [ ] **Add odds-cap safeguard to `backtester.py`** for ongoing significance testing.
- [ ] **Heal other missing migration-block indexes on live DB** — `idx_predictions_status`
      (v14), `idx_predictions_market_closed` (v15), `idx_api_calls_*`, `idx_smart_money_log_*`
      never ran (same reset gap). Low-impact (tiny tables) but backport to base DDL.
- [ ] **#2** model execution cost (spread+gas) in paper/shadow ledger (fill at ask).
- [ ] **#4** test a FADE (mean-revert) variant vs FOLLOW — lagging-signal hypothesis.
- [ ] **Watch resumption** — confirm first post-fix trade is gated correctly (no >0.90
      entries, no <$5K-volume entries) and monitor `vault.db` growth at 391 markets.
