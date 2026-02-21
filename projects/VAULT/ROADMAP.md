# VAULT Development Roadmap

Living document for planned optimisations, fixes, and future development.
Source: momentum-only audit (264 trades, Feb 16-21 2026, +$3.53 PnL on $843 cost basis).

---

## Pending — High Priority

### Per-market cost-basis cap
**Status**: Not implemented
**What**: Add `momentum_max_cost_per_market` config param (suggested: $15). In `_analyze_momentum_opportunities()` (agent.py ~496), check `current_exposure + bet_size > cap` and skip.
**Files**: `vault/agent.py`, `config/default.yaml`
**Evidence**: Delray Beach Wong/Cobolli: 15 trades, $76.52 cost, -$22.99. FURIA/TheMongolz: 10 trades, $42.42 cost, -$12.28. TSLA close above $410: 8 trades, $44.56 cost, -$13.75. The existing `momentum_max_exposure_pct: 0.50` allows $30+ per market — far too loose.
**Impact**: Would have prevented ~$50-60 of the $89.80 in catastrophic losses. Single biggest improvement available.
**Risk**: Low.

### Block entries at odds >= 90%
**Status**: Not implemented
**What**: In `_analyze_momentum_opportunities()` (agent.py ~374), change `entry_price >= 0.995` to `entry_price >= 0.90`.
**Files**: `vault/agent.py`
**Evidence**: 64 trades at entry_odds >= 0.90, net PnL -$7.62 on $219 cost. 24 trades at >= 0.99 are dead money ($0.01 profit on $54 cost). Max upside 11%, downside is total loss.
**Impact**: Eliminates ~$7.62 in dead-money trades.
**Risk**: Low.

### Fix O/U pattern filter gap
**Status**: Not implemented
**What**: Verify `_NOISY_PATTERNS` filter (agent.py ~350) catches all over/under, spread, and draw market phrasings. The Girona FC "O/U 2.5" variant leaked through.
**Files**: `vault/agent.py`
**Evidence**: Girona/Barcelona O/U 2.5: 5 trades, -$17.94 on $17.97 cost (near total loss). These markets move chaotically during live play.
**Impact**: Prevents repeat of -$18 single-market disaster.
**Risk**: None.

### Side-switching cooldown
**Status**: Not implemented
**What**: Once we've closed a position on one side and velocity flips, require 2h cooldown AND 2x normal velocity threshold before re-entering the opposite side. Current cooldown is only 1h.
**Files**: `vault/agent.py` (~543-587), `config/default.yaml`
**Evidence**: 13 markets had both-side trades, net PnL -$67.52. BTC $68-70K: flipped sides, -$17.58. TSLA $410: flipped sides, -$13.75. Wong/Cobolli: flipped sides, -$22.99.
**Impact**: Would prevent ~$40-50 in side-switching losses.
**Risk**: Low.

---

## Pending — Medium Priority

### Reduce max positions per market: 5 to 3
**Status**: Not implemented
**What**: Change `momentum_max_positions_per_market` from 5 to 3 in config.
**Files**: `config/default.yaml`
**Evidence**: Top 10 markets by trade count averaged 12.5 trades each. Belt-and-suspenders with the per-market cost cap.
**Impact**: Marginal on its own (cost cap is more important), prevents edge cases.
**Risk**: Low.

### Post-loss full market skip (2h cooldown)
**Status**: Not implemented
**What**: After realising a loss > $2 on a market, skip the market entirely for 2h (not just cap to 1 position like the existing burned-market guard). Tighten the existing `burned_market_lookback_hours: 4.0` / `burned_market_loss_threshold: -2.00` guard.
**Files**: `vault/agent.py` (~448-468), `config/default.yaml`
**Evidence**: Markets that cause losses tend to keep causing losses in the same session. FURIA/TheMongolz: 10 trades in 2h, -$12.28.
**Impact**: Would have prevented $10-15 of cascade losses.
**Risk**: Low-medium.

### Odds-band-aware sizing multipliers
**Status**: Not implemented
**What**: Add odds-band multipliers to velocity-scaled sizing in `_analyze_momentum_opportunities()` (agent.py ~470-497). Entry odds 30-50%: 0.5x, 50-70%: 1.25x, 85-95%: 0.75x.
**Files**: `vault/agent.py`
**Evidence**: 50-70% band: 78 trades, +$39.15, 58% win rate (proven sweet spot). 30-50% band: 36 trades, -$31.06, 33% win rate (disaster). Capital should flow to where it works.
**Impact**: Could improve PnL by $15-20 by right-sizing into proven ranges.
**Risk**: Medium. Odds bands may shift as market mix changes — review after 100 trades.

### Diagnose 500-hold streak
**Status**: Not implemented
**What**: Add per-stage filter logging to `_analyze_momentum_opportunities()` — count how many markets pass each filter stage per cycle. Check if `momentum_min_velocity_1h: 0.10` is too high, verify market discovery is still populating fresh data.
**Files**: `vault/agent.py` (~281), pipeline logging
**Evidence**: 500+ consecutive holds. System not trading, burning $0.16/day on API costs regardless.
**Impact**: Unknown until diagnosed. Could resume $1-3/day trading volume.
**Risk**: Medium. Must implement safety items (cost cap, odds gate, side-switching cooldown) FIRST before loosening any thresholds.

---

## Implemented

### Split stale exit timers (v16.20)
**Deployed**: 2026-02-21
**What**: Reduced `stale_min_hours_losing` from 1.0h to 0.5h (cut losers faster). Increased `stale_min_hours_profitable` from 2.0h to 3.0h (let winners run longer).
**Files**: `config/default.yaml`
**Evidence**: Duration <1h: 163 trades, -$27.46 (losers held too long). Duration 1-6h: 77 trades, +$39.38 (winners exited too early). Splitting timers addresses both sides without conflict.
**Expected impact**: Shifts $15-25 from the <1h loss bucket into the 1-6h profit bucket.

---

## Deferred — Needs More Data

### Haiku validation model upgrade
Consider upgrading momentum validation from Haiku ($0.001/call) to Sonnet ($0.005/call) for better signal quality. Only revisit after core fixes are implemented and trading resumes. Smart Haiku routing already skips Haiku for clear signals.

### Sports market time-of-day restrictions
Track game_start_time and build game-phase-aware logic. The existing noisy-pattern filter and oscillation dampener cover the worst cases. Only pursue if post-fix data shows sports markets remain problematic.

### Dynamic streak-based sizing
Scale bet sizes down after consecutive losses, up after wins (anti-martingale). 264-trade sample too small to validate with statistical confidence. Per-market caps and odds-band sizing address the same problem more directly.

### Per-category momentum strategies
Different velocity thresholds, sizing, and exit rules for crypto vs sports vs political markets. Requires market classification infrastructure that doesn't fully exist. Get universal improvements right first, then specialise.
