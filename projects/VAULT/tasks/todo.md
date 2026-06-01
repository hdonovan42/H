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
- [x] **#2 (part 1) accounting reconciliation** — v21.1. Reported P&L −$8.01 was a
      gross trade tally; real account P&L is **−$1.62** (value $18.38 − verified
      deposits $20.00). Root cause: `_reconcile_balance` footgun booked late
      trade-settlement drift as phantom deposits (+$6.05). Killed the footgun;
      added `get_account_pnl`/`get_verified_deposits` + dashboard/CLI/API surfaces.
- [x] **#2 (part 2) investigated + drift fixed** — v21.2. Spread already captured
      (actual fill cost); gas is cents in a separate MATIC pot (skipped, user call).
      The $1.27 drift was the redemption residue, not gas/spread: reconciled ledger
      balance $18.38 → on-chain $17.11 via `vault reconcile-balance`. Account P&L
      corrected −$1.62 → **−$2.89** (true money-only loss).
- [ ] **Shadow A/B spread** (only if reactivated) — shadow_trades fill at mid, not
      ask/bid; overstates paper P&L. Dormant now, low priority.

### Known loose ends — accounting (as of v21.2, 1 Jun 2026)
- **Trade tally still distorted** (LOOSE END): the headline `Trading P&L` (−$8.01)
  = `SUM(predictions.pnl WHERE closed)`. Its per-trade rows still carry the
  historical phantom-deposit / redemption-reversal distortions, so the GROSS tally
  (−$8.01) does NOT match the reconciled Account P&L (−$2.89). Account-level numbers
  are now correct (balance $17.11 = on-chain; account_pnl −$2.89 = value − $20 deposits);
  only the per-trade `predictions.pnl` decomposition is dirty. Left intact for audit
  integrity. Cleaning it = a forensic pass re-attributing phantom proceeds to their
  originating trades (rebuild each `predictions.pnl` from actual fills/redemptions).
  Not urgent — it's a reporting/decomposition issue, not a money issue.
- **$0.09 expected-vs-actual on-chain** — `compute_expected_onchain` ($17.20) vs actual
  USDC.e ($17.11); settlement/gas/rounding noise, within tolerance. Ignore.
- **Reconciliation tooling** — `vault reconcile-balance [--yes]` exists for future drift;
  refuses while positions in flight. The redemption_adjustment code that caused the
  residue is already removed, so recurrence is unlikely.
- [ ] **#4** test a FADE (mean-revert) variant vs FOLLOW — lagging-signal hypothesis.
- [~] **Resumption observed (1 Jun 2026, cycle ~28162)** — discovery fix CONFIRMED
      working: 383 markets tracked, `3 velocity alerts`, momentum logic actively
      evaluating. Cycle time ~1.9s. Still need to observe a first actual fill to
      confirm the favourite cap + $5K floor gate live.
- [ ] **BLOCKER — bets below CLOB minimum** (NEW, found during v21.2 deploy): base
      bet = `momentum_base_bet_pct` 5% × balance $17.11 = **$0.86 < $1.00 CLOB min**,
      so every candidate is skipped ("Momentum skip (below CLOB min)"). The 5% base
      only clears $1.00 at balance ≥ $20; the reconciliation to $17.11 worsened it.
      Options: (a) raise `momentum_base_bet_pct` to ~0.06–0.07 (6–7% → $1.03–$1.20),
      or (b) top up the wallet to ≥ $20. Velocity-scaled bets clear the min, but the
      BASE entry can't. Needs a decision before VAULT can trade again.
- [ ] **Monitor `vault.db` growth** at ~383 tracked markets (48h prune bounds it).
