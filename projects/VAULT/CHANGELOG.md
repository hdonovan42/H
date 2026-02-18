# VAULT Algorithm Changelog

Track every change to the pipeline and decision-making algorithm.
Correlate cycle ranges with performance to identify what works.

---

## v16.8 — Z-Score Gate for Non-Sports Velocity Threshold

**Deployed**: 2026-02-18 | **Baseline**: $73.88 balance, 479.7d runway, +$34.87 trading P&L

The 10% non-sports velocity floor was blocking valid signals like DeepSeek V4 (sustained -9.5%/1h, z=-6.7, YES 40%→24%). A $2 NO bet at 65% would now be worth $2.34 (+17% ROI). Rather than blanket-lowering the threshold (non-sports WR is 40%), added a conditional z-score gate: velocity 7%+ is allowed through if z-score >= 4.0 (statistically significant moves only).

### Files modified
| File | Change |
|------|--------|
| `vault/agent.py` | Z-gate override in velocity filter — allows 7%+ velocity when z >= 4.0 (non-sports only) |
| `config/default.yaml` | `z_override_min_velocity: 0.07`, `z_override_threshold: 4.0` |

### What to Watch
- Z-gate activations: `grep "z-gate override" logs`
- Sports markets unaffected (gate is `not is_sports` gated)
- Win rate of z-gate bets vs regular momentum bets

---

## v16.7 — Enriched Market Intelligence for Momentum Validator

**Deployed**: 2026-02-18 | **Schema**: v13 | **Baseline**: $73.88 balance, 441.3d runway, +$34.87 trading P&L

### Enriched market data (schema v13)
Momentum validator was deciding follow/no-follow with only price numbers and velocity — no context about *what* the market actually is. Now pulling 7 new fields from the Gamma API: `description`, `volume_24h`, `liquidity`, `spread`, `competitive`, `game_start_time`, `event_title`. Stored in `musk_markets` and passed through to the Haiku prompt.

### Pre-filter: spread + liquidity gates
Markets with wide spread (>10%) or low liquidity (<$50) produce false velocity signals from unreliable prices. These are now filtered out *before* any API call, saving Haiku costs on junk signals.

### Richer Haiku prompt
Momentum validation prompt now includes resolution criteria, event title, game start time, 24h volume, liquidity, and spread. Haiku can now distinguish "NBA game starting in 5 minutes" from "obscure market with $30 liquidity."

### Files modified
| File | Change |
|------|--------|
| `vault/db.py` | Schema v13 migration — 7 new columns on `musk_markets` |
| `vault/polymarket.py` | Parse enriched fields from Gamma API response |
| `vault/market_discovery.py` | Upsert new fields into `musk_markets` |
| `vault/agent.py` | Spread/liquidity pre-filters, pass market_context to Haiku |
| `vault/prompts.py` | `build_momentum_prompt()` accepts and renders market context |

### What to Watch
- Spread/liquidity skips: `grep "wide spread\|low liquidity" logs`
- Haiku prompts now longer (~50 more tokens) — monitor momentum_validation avg cost
- Schema migration runs on first cycle after deploy

---

## v16.6 — Sports Velocity Floor + Dead Code Cleanup

**Deployed**: 2026-02-18 | **Baseline**: $73.88 balance, 394.6d runway, +$34.87 trading P&L

### Sports-specific velocity threshold
Sports momentum has 65% WR (79 bets) vs 40% for non-sports (43 bets). The blanket 10% minimum velocity floor was blocking profitable sports signals in the 5-9% band. Added `_is_sports_market()` detector (matches "vs"/"vs." + league/tournament keywords) and `momentum_min_velocity_1h_sports: 0.05` config. Non-sports keeps 10%.

### Dead code cleanup (751 lines removed)
Three-agent review team (auditor, defender, optimiser) traced every module and function. Removed:
- `musk_markets.py`, `actuators/buy.py`, `sell.py`, `research.py` (4 files deleted)
- `_run_decider()`, `_get_actionable()`, `_parse_decider_json()` from agent.py
- `build_decider_prompt()`, `build_edge_prompt()` from prompts.py
- Dead pipeline.py imports (`collect_x_data`, `run_sentinel`, intelligence functions)
- Config keys: `focus`, `x_keywords`, `max_x_calls_per_cycle`

Defender verified all kept modules have live API endpoints (dashboard depends on them). `_run_tool_loop()` kept as pipeline crash fallback. `polymarket_keywords` kept as live fallback for market discovery.

### Files modified
| File | Change |
|------|--------|
| `vault/agent.py` | Add `_is_sports_market()`, sports velocity floor, remove decider + actionable + parser |
| `vault/prompts.py` | Remove `build_decider_prompt()` + `build_edge_prompt()` (~290 lines) |
| `vault/pipeline.py` | Remove dead imports |
| `vault/actuators/__init__.py` | Remove conditional crypto loader |
| `config/default.yaml` | Add `momentum_min_velocity_1h_sports`, remove dead keys |
| `vault/musk_markets.py` | Deleted |
| `vault/actuators/buy.py`, `sell.py`, `research.py` | Deleted |

### What to Watch
- Sports markets at 5-9% velocity passing through: `grep "weak velocity, sports" logs`
- Non-sports still blocked below 10%: `grep "weak velocity, non-sports" logs`
- No import errors after file deletions

---

## v16 — Agent Team Review: Defensive + Offensive Overhaul
**Deployed**: 2026-02-17 | **Schema**: v12 | **Baseline**: $80.62 balance, 59.3d runway, +$45.25 trading P&L

Three-agent review team (profit maximisation, capital efficiency, win rate optimisation) analysed 174 closed trades and debated priorities. Key finding: **sports momentum at 0.50–0.70 entry odds is the edge** (91% WR, 45.8% ROI). All major losses came from non-sports markets or sub-50% entry odds. Implemented across three priority tiers:

### P0 — Defensive Guardrails (v16.0)

**Exposure cap fix**: `_analyze_momentum_opportunities()` was computing `max_exposure_usd = balance * 0.50` using cash balance only. Each bet shrinks cash, so the cap erodes as positions accumulate. MrBeast got 14 positions ($26.28 = 31% of total value) in 26 minutes. Fix: cap now uses `(balance + positions_value) * 0.50` — total portfolio value.

**O/U / draw / spread filter**: Markets with inherently noisy in-game momentum (over/under, draw, spread, totals) are now blocked from momentum entry. The Girona O/U disaster (-$17.94 from 5 bets) was the single biggest loss event — 30% of all losses. Simple question-text pattern matching, placed before API calls.

**Per-market position cap**: Hard limit of 5 positions per market (all sides combined), configurable via `momentum_max_positions_per_market`. Defence in depth against accumulation regardless of exposure percentage.

### P1 — Offensive Tuning (v16.1)

**Max bet $4 → $6**: The 3x pyramid tier (3x × $2 = $6) was capped back to $4 — effectively neutering pyramiding. Raising to $6 lets the full pyramid function. The 50% exposure cap is the real guardrail.

**Pyramid thresholds lowered**: New 4-tier system: 5%→1.5x, 15%→2x, 30%→3x (was 10%→2x, 25%→3x). Adds a 1.5x tier so scaling engages earlier when the signal is confirming but there's still runway.

**50% minimum entry odds**: Sub-50% momentum entries had 0% WR historically. The 0.50–0.70 bucket is 91% WR and 45.8% ROI — that's where the alpha lives.

**10% minimum velocity**: The 5–10% v_1h band had 56% WR vs 100% for 10–20%. Raises the floor from `sharp_threshold_1h: 0.05` (alert detection, unchanged) to `momentum_min_velocity_1h: 0.10` for actual entry.

### P2 — Exit Refinements (v16.2, v16.3)

**Split stale exit**: Profitable positions get 2h before the stale check fires (let winners breathe through halftime/set breaks). Unprofitable positions keep the 1h floor (cut losers fast). Replaces the single `stale_min_hours: 1.0` with `stale_min_hours_profitable: 2.0` / `stale_min_hours_losing: 1.0`.

**High-water-mark trailing stop**: New `_exit_trailing_stop()` function + `peak_roi` column (schema v12). Tracks each position's peak unrealised ROI. Exits when ROI drops 15pp below peak while still profitable (PnL > $0.25, peak was >= 15%). Runs before stale exit in the chain. Protects against the 2–6h reversal pattern that was net -$9.16 historically.

**Min add ROI 0% → 2%**: `momentum_add_min_roi` raised from 0.0 to 0.02. Filters noise-level "profitable" adds (+$0.001) without a cooldown timer — the P0 position cap and exposure cap already prevent accumulation.

### Data from the review

| Metric | Value |
|--------|-------|
| Sports momentum WR | **90%** (45W/5L) |
| Non-sports WR | **41%** (25W/36L) |
| Best entry odds | 0.50–0.70: 91% WR, 45.8% ROI |
| Best velocity band | v_1h 10–20%: **100% WR** (22W/0L) |
| Biggest loss event | Girona O/U: -$17.94 (5 bets, 1 market) |
| Flat trade rate | 34.5% (60/174 at $0 PnL) |
| Win/loss ratio | 1.02x ($1.51 avg win / $1.47 avg loss) |

### Files modified
| File | Change |
|------|--------|
| `vault/agent.py` | Exposure cap fix, O/U filter, position cap, min entry odds, min velocity, pyramid thresholds, split stale exit, trailing stop function, exit chain wiring |
| `vault/db.py` | Schema v12: `peak_roi REAL DEFAULT 0` on predictions |
| `config/default.yaml` | `momentum_max_bet_usd: 6.00`, `momentum_add_min_roi: 0.02`, `momentum_max_positions_per_market: 5`, `momentum_min_velocity_1h: 0.10`, `stale_min_hours_profitable: 2.0`, `stale_min_hours_losing: 1.0`, `trailing_stop_drop/min_peak/min_pnl` |

### What to Watch
- Accumulation: MrBeast (14 positions) and Somalia (8 positions) were created before P0 deployed — stale exit will clean them up
- Position cap: "Momentum skip: ... N positions >= 5 cap" log messages
- O/U filter: "Momentum skip (noisy market type)" log messages
- Entry filters: "Momentum skip (low entry odds)" and "Momentum skip (weak velocity)" messages
- Trailing stop: "Trailing stop exit: ... peak ROI +X%, current +Y%" messages
- Split stale: profitable positions should hold longer (up to 2h) before stale exit fires
- Pyramid: "Momentum pyramid: ... ROI +5% → 2x" should fire more frequently than before

---

## v15.3 — Stale Momentum Exit
**Deployed**: 2026-02-17 | **Baseline**: $71.46 balance, 52.8d runway, +$45.78 trading P&L

Adds mechanical exit logic for momentum positions where momentum has stalled. Previously, momentum bets had no exit except opportunity-cost (price near 100%) or market resolution — a bet entered at 68% that stalls at 70% would sit indefinitely. Now every cycle rechecks velocity on open momentum positions and takes profit or cuts losses.

**Why**: Overnight data shows 25W/0L but all wins relied on price running to ~95%+ for opportunity-cost to kick in. If momentum dies mid-way and we're sitting on profit, we should take it. If momentum dies and we've held 4h+ at a loss, cut it.

### Decision matrix
| Condition | Action |
|-----------|--------|
| Held > 1h + profitable + velocity stalled | SELL (profit-take) |
| Held > 4h + velocity stalled | SELL (timeout cut) |
| Velocity alive (v_1h > 2% in our direction) | HOLD |
| Held < 1h | HOLD (too early) |

"Velocity stalled" = `v_1h` is None/zero, reversed, or `abs(v_1h) < 2%`.

### Files modified
| File | Change |
|------|--------|
| `vault/agent.py` | New `_exit_stale_momentum(conn)` function; called in `run_cycle()` after opportunity-cost exit |
| `config/default.yaml` | `stale_min_hours: 1.0`, `stale_max_hours: 4.0`, `stale_velocity_threshold: 0.02` |

### What to Watch
- `Stale momentum exit:` messages in logs when momentum dies on an open position
- Profitable momentum positions held > 1h with dead velocity should exit
- Positions with active momentum (v_1h > 2% in our direction) should NOT exit
- Non-momentum positions (intel pipeline) should be completely unaffected
- $0 API cost — pure mechanical, no Haiku call

---

## v15 — Volatility-Normalized Velocity (Z-Score)
**Deployed**: 2026-02-16 | **Baseline**: $41.00 balance, 28.2d runway, +$22.20 trading P&L

Normalizes velocity against 24h volatility baseline via z-score: `z_1h = v_1h / stddev_1h`. Tennis matches flip-flopping ±10%/hr now produce z~1 (noise suppressed), while a political market spiking +10% on a flat baseline produces z~4 (signal amplified). Falls back to raw velocity for markets with < 30 snapshots.

**Why**: Raw `v_1h` treats all 10% moves as equal. Sports markets are inherently volatile — their moves are expected. Political/event markets are flat for days then spike — those spikes are significant. Z-score separates the two.

### How it works
- **Z-score computation**: `stddev_1h = stdev(24h per-cycle deltas) * sqrt(snaps_per_hour)`, then `z_1h = v_1h / stddev_1h`
- **Sharp detection**: z >= 2.0 triggers sharp (replaces raw 5%/10% thresholds when z available)
- **Sizing**: z >= 3.0 → 1.5x, z >= 4.0 → 2.0x (replaces raw 20%/40% thresholds when z available)
- **Sort priority**: momentum candidates sorted by |z_1h|, falling back to |v_1h| for new markets
- **Fallback**: Markets with < 30 snapshots in 24h use raw velocity — new markets aren't penalized
- **stddev floor**: 0.001 prevents infinite z on perfectly flat markets

### Files modified
| File | Change |
|------|--------|
| `vault/edge_calculator.py` | `calculate_velocity()`: 24h stddev, z_1h, z-score-first sharp detection; `_fmt_velocity()`: append `z=X.X`; velocity alert/edge dicts: pass through z_1h |
| `vault/agent.py` | `_analyze_momentum_opportunities()`: z-score sort, sizing, item dict, logging; `_execute_momentum_bets()`: z-score sort; `_call_momentum_haiku()`: pass z_1h |
| `vault/prompts.py` | `build_momentum_prompt()`: accept + display z_1h in Haiku context |
| `config/default.yaml` | `z_sharp_threshold: 2.0`, `z_min_snapshots: 30`, `z_sizing_low: 3.0`, `z_sizing_high: 4.0` |

### What to Watch
- `_fmt_velocity` output in logs should include `z=X.X` for markets with 30+ snapshots
- Live sports (tennis, CS:GO): should show **low z-scores** (~1-2) despite big raw moves
- Political/event markets with sudden spikes: should show **high z-scores** (3+)
- Markets with < 30 snapshots: should use raw velocity, no z in logs
- A z=1.5 move should NOT trigger sharp even if raw |v_1h| = 20%

---

## v14.1 — Position-Aware Momentum (Add/Hold, Not Repeat Entry)
**Deployed**: 2026-02-16 | **Baseline**: $41.00 balance, 28.2d runway, +$22.20 trading P&L

Treats each market as a single position. First entry gets full Haiku validation; subsequent cycles with an existing same-side position only add if profitable, with no Haiku call ($0 API). Fixes the bug where 4 identical $3 bets were placed on Rio Open across 4 consecutive cycles.

**Why**: Each cycle treated every velocity alert as a fresh entry — Haiku validated again, base sizing applied again, no memory of previous bets. The pyramiding multiplier existed but was ineffective at breakeven ROI (1.0x = full bet again).

### How it works
- **New entry** (no same-side position): full Haiku call, base sizing — unchanged
- **Add to profitable position** (ROI > 0%): skip Haiku, synthetic conf=0.8, pyramid sizing — $0 API
- **Add to flat/losing position** (ROI <= 0%): **skip entirely** — the core fix
- **Opposite-side position**: treated as new entry (different lookup key)

### Files modified
| File | Change |
|------|--------|
| `vault/agent.py` | `_analyze_momentum_opportunities()`: position lookup `(market_id, side)`, add/new branch before Haiku call |
| `vault/agent.py` | `_resolve_smart_money_entries()`: `momentum_add` resolved alongside `momentum_bet` |
| `config/default.yaml` | `momentum_add_min_roi: 0.0` under `velocity:` |

### What to Watch
- Existing position + flat/losing: `Momentum skip (add, not profitable): ... ROI +0.0%`
- Existing position + profitable: `Momentum add candidate: ... (no Haiku call)`
- Fresh market: normal `momentum_validation` Haiku call
- Smart money log: `momentum_add` vs `momentum_bet` distinguishes entry types
- Cycle cost should be $0 when all signals are adds blocked by ROI gate

---

## v14 — Pure Velocity-Following Momentum System
**Deployed**: 2026-02-16 | **Baseline**: $55.23 balance, 39.2d runway, +$39.80 trading P&L

Replaces the "Haiku estimates probability + edge" momentum system with a pure velocity-following approach. Direction is now mechanical (velocity sign), sizing scales with velocity magnitude, and Haiku's role is reduced to binary follow/no-follow validation. Momentum bets execute directly — no decider Haiku call.

**Why**: The old system asked Haiku to estimate probability and calculate edge, producing fake numbers (e.g. declaring "6% edge" on an 86% NO market). Profitable bets (T20 +$4.19, CS:GO +$10.11) succeeded because they followed strong velocity, not because of Haiku's probability estimates.

### Architecture change
1. **Mechanical direction**: `v_1h < 0` → bet NO, `v_1h > 0` → bet YES
2. **Velocity-scaled sizing**: $2 base, $3 at |v_1h| >= 20%, $4 at |v_1h| >= 40%
3. **Haiku validates** "should we follow?" (binary follow + confidence), not "what's the probability?"
4. **Direct execution**: bypasses decider Haiku call, saves ~$0.0007/cycle
5. **Confidence gate**: Haiku must return `follow: true` with confidence >= 0.6

### Files modified
| File | Change |
|------|--------|
| `vault/prompts.py` | `build_momentum_prompt()` now takes side/entry_price/remaining; asks follow/no-follow instead of probability |
| `vault/agent.py` | `_analyze_momentum_opportunities()` rewritten: mechanical direction, velocity sizing, new response parsing |
| `vault/agent.py` | New `_execute_momentum_bets()`: picks best by |v_1h| * confidence, calls bet actuator directly |
| `vault/agent.py` | `run_cycle()` momentum path short-circuits decider; `_parse_momentum_response()` parses follow/confidence |
| `config/default.yaml` | Replaced `momentum_min_edge`/`momentum_min_confidence` with `momentum_follow_confidence`, `momentum_base_bet_usd`, `momentum_vel_scale_20/40` |

### What to Watch
- Haiku receives new follow/no-follow prompt (check VPS logs for `momentum_validation`)
- Direction matches velocity sign (side not chosen by Haiku)
- Sizing scales with velocity magnitude ($2/$3/$4)
- `entry_confidence` stores follow confidence (0.6-1.0), `entry_edge` stores velocity magnitude
- No decider API cost on momentum cycles (only the validation Haiku call)
- Barcelona-type bets (high odds, low remaining upside) should get `follow: false`

---

## v13.7 — Pre-filter Extreme Odds from Momentum Pipeline
**Deployed**: 2026-02-16 | **Baseline**: $55.96 balance, 42.0d runway, +$36.03 trading P&L

Markets above 99.5% (or below 0.5%) odds now skip the Haiku analysis call entirely. Previously these fired a Haiku call (~$0.0007 each) only to be rejected by the opportunity cost gate, producing noisy "bet blocked" dashboard entries. Also filters historical "bet blocked" messages from the cycles API alongside existing auto-hold filtering.

### Files modified
| File | Change |
|------|--------|
| `vault/agent.py` | Pre-check `market_odds` before `_call_momentum_haiku` in velocity alert loop |
| `vault/api.py` | Filter `bet blocked:%` from cycles query (same pattern as `auto-hold:%`) |

### What to Watch
- No more "bet blocked: would immediately exit" in VPS logs
- Dashboard recent decisions should be cleaner
- Legitimate momentum bets (< 99.5% odds) still fire normally

---

## v13.6 — Fold Intel Bets into Legacy, Remove INTEL Card
**Deployed**: 2026-02-16 | **Baseline**: $75.97 balance, 57.7d runway, +$36.03 trading P&L

Intel (pipeline) predictions reclassified as legacy. INTEL source summary card removed from dashboard. Only MOMENTUM and LEGACY remain.

### Files modified
| File | Change |
|------|--------|
| `vault/api.py` | `_pred_source()` no longer returns `pipeline`; `intel_disabled` flag removed |
| `dashboard/src/components/BetsPanel.jsx` | INTEL style removed from `SOURCE_STYLES`, `intelDisabled` prop removed |

---

## v13.5 — Disable Tweets, Sentinel & Intelligence (Momentum-Only Mode)
**Deployed**: 2026-02-16 | **Baseline**: $75.98 balance, 58.1d runway, +$36.03 trading P&L

Pipeline phases 1a–2b fully skipped: tweet collection, intelligence loading, sentinel, and Opus estimates. Momentum works purely on price velocity from odds snapshots — none of these fed into it. Removes wasted subprocess calls (bird CLI) and occasional Haiku calls (sentinel).

### Changes
- Phases 1a (tweets), 1b (Opus intel), 1c (intelligence loading), 2 (sentinel), 2b (Opus estimates) replaced with single skip log line
- Market discovery (Phase 3) unaffected — falls back to config keywords, momentum uses volume path
- Edge calculation (Phase 4) unaffected — velocity alerts still fire normally

### Files modified
| File | Change |
|------|--------|
| `vault/pipeline.py` | Replace phases 1a–2b with momentum-only skip |

### Reversibility
Restore the original phase blocks to re-enable. All DB tables (x_posts, sentinel_alerts, opus_estimates, intelligence) preserved.

### What to Watch
- Cycles should show $0.0000 cost when no momentum alerts fire (no more sentinel Haiku calls)
- Momentum bets should still trigger on sharp velocity moves
- Market discovery still tracking high-volume markets for snapshots

---

## v13.4 — Collapse Closed Positions by Default
**Deployed**: 2026-02-16 | **Baseline**: $76.00 balance, 58.6d runway, +$36.03 trading P&L

Closed positions section now uses the same collapsible toggle as legacy — collapsed by default showing count and total PnL, click to expand.

### Files modified
| File | Change |
|------|--------|
| `dashboard/src/components/BetsPanel.jsx` | Closed section wrapped in collapsible toggle, matching legacy pattern |

### What to Watch
- Closed section should show `▶ CLOSED (N) +$X.XX` collapsed by default
- Click expands to show individual closed positions

---

## v13.3 — Dashboard "INTEL PAUSED" Indicator
**Deployed**: 2026-02-16 | **Baseline**: $76.00 balance, 59d runway, +$36.03 trading P&L

Intel bets were disabled in v13.2 but the dashboard didn't reflect this. Added a visible PAUSED state on the INTEL source summary card so it's immediately obvious intel is off.

### Changes
- API returns `intel_disabled: true` in predictions response
- INTEL card renders at 50% opacity with red "PAUSED" label

### Files modified
| File | Change |
|------|--------|
| `vault/api.py:330` | Add `intel_disabled: True` to predictions response |
| `dashboard/src/components/BetsPanel.jsx` | `SourceSummary` shows PAUSED indicator on intel card |

### What to Watch
- INTEL card on vault.hjd.ai should show dimmed with "PAUSED" label
- When intel is re-enabled, remove the `intel_disabled` flag from the API response

---

## v13.2 — Disable Intel Bets, Momentum Only
**Deployed**: 2026-02-16 | **Baseline**: $59.60 balance, 47.7d runway, +$35.66 trading P&L

### Thesis
Momentum bets are the alpha — intel (Opus-estimated) bets haven't earned their ~$0.20/day cost. Pause intel entirely to cut burn rate and let momentum run unencumbered.

### Changes
- **Skip `_get_actionable()` intel items** — `actionable = None` so no `bet`/`exit` edges reach the decider
- **Skip daily Opus call** — `update_intelligence()` no longer fires, saving ~$0.20/day
- **Skip emergency Opus re-estimation** — major events logged but no Opus triggered
- **Remove early return on empty estimates** — pipeline continues to edge calculation so velocity alerts still fire

### What is NOT touched
Momentum path is completely untouched: `_analyze_momentum_opportunities()`, `_call_momentum_haiku()`, `_run_decider()`, velocity config, `calculate_edges()`, `discover_markets()`, tweet collection, sentinel, all exit logic.

### Files modified
| File | Change |
|------|--------|
| `vault/agent.py` | `actionable = None` instead of `_get_actionable()` |
| `vault/pipeline.py` | Skip `update_intelligence()`, skip emergency Opus, remove early return |

### Reversibility
Revert these 4 changes to re-enable intel. `opus_estimates` table and intelligence docs are preserved.

### What to Watch
- Burn rate should drop ~$0.20/day (no daily Opus calls)
- Momentum bets should still fire normally on velocity alerts
- No `action: "bet"` intel items should reach the decider
- Existing open positions still monitored by sentinel

---

## v13.1 — Hard Price Ceiling + Decider Entry Gate
**Deployed**: 2026-02-16 | **Baseline**: $59.62 balance, 48.3d runway, +$35.66 trading P&L

### Problem
8 CS:GO positions at 99.95% weren't exiting — the opportunity cost formula is rate-based, and when `days → 0` the risk-free rate shrinks to near-zero, making even dust-level returns (0.05%) look worthwhile. Separately, momentum was entering positions that the exit sweep would immediately sell on the next cycle (buy $4 → exit next cycle → repeat).

### Changes
- **Hard price ceiling**: positions at ≥99.5% exit immediately regardless of rate comparison (`our_price >= 0.995` short-circuits in `_exit_opportunity_cost`)
- **Same ceiling on entry**: momentum analysis gate also blocks entries at ≥99.5%
- **Decider execution gate** (new): right before `bet_actuator.execute()`, fetches *live* odds and runs the full opportunity cost check. Blocks any bet that would immediately trigger an exit. This is the single chokepoint — no bet can bypass it.

### Files modified
| File | Change |
|------|--------|
| `vault/agent.py` | `_exit_opportunity_cost()` +ceiling, momentum entry gate +ceiling, new decider-level opportunity cost gate before bet execution |

### What to Watch
- CS:GO positions exited immediately on deploy (+$23 freed capital)
- Netflix and Starship positions unaffected (both well below 99.5%)
- No more enter-then-exit churn on near-resolved markets

---

## v13 — Universal Market Scanning + Opportunity Cost Exits
**Deployed**: 2026-02-16 | **Baseline**: $41.61 balance, 40.5d runway, +$25.78 trading P&L

### Thesis
Momentum signals exist across all of Polymarket, not just the Elon ecosystem. The cricket bet — VAULT's most profitable momentum trade — was found by accident (a "Tesla Megapack Australia" keyword matched "T20 World Cup: Australia vs Sri Lanka"). Opening up to all markets + replacing the hard 99% exit with an economics-based opportunity cost model.

### Changes

**Broadened market scanning** — velocity detection now covers ALL Polymarket markets, not just keyword-matched ones:
- Fetches top 500 active markets by volume (was 300)
- ALL markets above $10k volume are tracked for velocity (upserted into `musk_markets`, odds snapshots recorded)
- Keyword filter only gates what Opus sees for intelligence analysis — velocity scanning is unrestricted
- ~55 markets tracked per cycle (was ~11). Covers geopolitics, sports, elections, crypto, entertainment, science
- New markets discovered: US/Iran strikes ($9.4M), Academy Awards ($1M), Venezuela politics ($1M), NBA games, tennis, Colombia elections, Japan unemployment, etc.

**Opportunity cost exit** — replaced hard ≥99% threshold with principled economic model:
- Formula: exit when `remaining_return ≤ risk_free_return` over the same period
- `remaining_return = (1 - our_price) / our_price` — max gain if we win
- `risk_free_return = 10% annual × (days_to_resolution / 365)`
- Time-aware: holds a 99% position resolving tomorrow (1% over 1d = 365% annualised), exits a 95% position expiring in a year (5.3% < 10% risk-free)
- Config: `opportunity_cost_annual: 0.10`, `opportunity_cost_default_days: 30`

**Opportunity cost entry gate** — same logic blocks wasteful entries:
- Applied in bet actuator using LIVE odds (not stale cached data)
- Also applied in momentum analysis using cached odds (belt + suspenders)
- Prevents the churn loop: buy at 99.95% → sell next cycle → rebuy → repeat

### The Cricket Churn (the bug this fixes)
After the original cricket momentum bets (profitable, +$4.19), the market sat at YES=0.05%. Every cycle: momentum detected velocity → Haiku said "bet NO" → bet actuator bought NO at 99.95% → capital efficiency exit sold at ≥99% → repeat. 14 churned positions with $0 profit, burning Haiku API costs. Root cause: stale `musk_markets` cache showed 24% YES (market had been filtered from discovery), but bet actuator fetched live 0.05% YES.

### Decision table (10% annual opportunity cost)
| Our price | Remaining | Days | Risk-free | Decision |
|-----------|-----------|------|-----------|----------|
| 99.95% | 0.05% | 7d | 0.19% | **EXIT** |
| 99% | 1.01% | 7d | 0.19% | HOLD |
| 99% | 1.01% | 60d | 1.64% | **EXIT** |
| 95% | 5.26% | 30d | 0.82% | HOLD |
| 76% | 31.6% | 7d | 0.19% | HOLD |

### Files modified
| File | Change |
|------|--------|
| `vault/market_discovery.py` | Track all markets for velocity, keyword-filter only for intel return |
| `vault/agent.py` | `_exit_opportunity_cost()` replaces `_exit_maxed_positions()`, opportunity cost entry gate in momentum, `_remaining_return_pct()` + `_days_to_resolution()` helpers |
| `vault/actuators/bet.py` | Opportunity cost gate using live odds — final defence against wasteful entries |
| `config/default.yaml` | `opportunity_cost_annual`, `opportunity_cost_default_days`, `momentum_min_volume`, `momentum_max_exposure_pct` |

### What to Watch
- Velocity alerts on new market categories (sports, geopolitics, elections)
- Opportunity cost exits on existing positions as they approach resolution
- No more churn on near-resolved markets
- Snapshot table growth (~55 rows/cycle = ~79k/day) — may need periodic cleanup

---

## v12 — Momentum-First Architecture
**Deployed**: 2026-02-16 | **Baseline**: $41.72 balance, 19.1d runway, +$25.78 trading P&L

### Thesis
Momentum IS the alpha. Sharp price moves on Polymarket represent informed money — our edge is riding that signal, not independent analysis. The system should scale aggressively into confirmed signals while protecting against capital waste.

### Changes

**Smart momentum scaling** — removed hard deduplication rule that blocked additional bets on markets with open positions. Momentum bets now scale into confirmed signals:
- Each cycle still gets a fresh Haiku analysis, so signal quality is re-evaluated
- Exposure cap at **50% of balance per market** — prevents one market consuming everything
- Bet sizing respects remaining room under the cap (partial fills at the boundary)
- No price ceiling — capital efficiency exit at 99% handles the other end

**Pyramiding** — bet size scales with unrealised ROI on existing exposure to the same market. The P&L IS the confidence signal — if we're profitable, the signal has confirmed, so we should bet bigger:
- 0-10% ROI: 1x base bet
- 10-25% ROI: 2x base bet
- 25%+ ROI: 3x base bet
- Self-correcting: if we're underwater (signal was wrong), sizing stays at 1x

**Capital efficiency exit** — new `_exit_maxed_positions()` runs at cycle start. Sells any position where our side is priced >= 99%. No point tying up capital for days waiting for formal resolution when there's <1% remaining gain. First trigger: 11 cricket momentum bets sold for +$4.19 realised.

**Veto noise reduction** — vetoes now only fire when there's an actual bet to block (`cf_size > 0`). Previously logged 71 vetoes with `counterfactual_size=0` — blocking bets that Kelly had already rejected. Pure noise.

**Mark-to-market smart money stats** — API summary endpoint now computes unrealised P&L for pending momentum/boost entries by looking up open predictions and current market odds, instead of showing $0 until resolution.

**Source classification** — predictions tagged as `pipeline` (Opus intel), `momentum` (smart money velocity), or `legacy` (old tool-loop). Three-way classification based on `entry_confidence` and `entry_reasoning`.

**Dashboard updates**:
- Source tags (INTEL/MOMENTUM/LEGACY) on every position with colour-coded chips
- Source performance summary card — deployed capital, unrealised + realised P&L, W/L per source
- Legacy positions collapsed by default — click to expand, shows aggregate P&L in header
- Odds shown to 2 decimal places (was 0dp — masked 99.95% as 100%)

### Cricket Incident (the case study)
T20 World Cup Australia vs Sri Lanka triggered 11 momentum bets in 25 minutes (pre-fix). Market moved from 38% → 0.05% YES. All NO bets profitable. Under the new 50% cap system:
- Bets 96-101 (entry 62-76%): **PASS** — captured +$4.18 of profit
- Bets 102-108 (entry 99-100%): mostly **PASS** but +$0.01 total — capital efficiency exit sold them all at 99%+
- Only the last 1-2 bets would be **BLOCKED** by cap — dead money at 100%
- Result: same +$4.19 P&L, capital freed immediately instead of locked for days

### Backtested Comparison (cricket bets)
| System | Deployed | P&L | ROI |
|--------|----------|-----|-----|
| **Pyramid + 50% cap** | **$18.92** | **+$5.86** | **+31%** |
| Flat + 50% cap | $18.92 | +$4.66 | +25% |
| No cap (actual) | $22.23 | +$4.19 | +19% |
| 15% cap (rejected) | $6.98 | +$3.25 | +47% |

### Why 50% cap beats 15% despite lower ROI
The 15% cap's 47% ROI is flattering — it only caught the risky early bets that happened to win. If the signal had been wrong, that same concentration would have been a 47% loss. The 50% cap deploys more capital, but crucially, the additional exposure goes in AFTER the signal has confirmed. The later dollars carry less risk than the first dollar. Higher ROI ≠ better risk-adjusted returns when the risk profile changes throughout the position build.

### Why pyramiding wins
The pyramid front-loads capital into the confirmed part of the move. At +22% ROI, bet [98] doubled to 2x — correctly identifying that the signal was real. Same total deployment as flat sizing, but the bigger bets were placed when confidence was highest. Result: +$1.20 more profit (+$5.86 vs +$4.66) for identical capital at risk.

### What to Watch
- Next momentum signal: verify pyramid scaling fires (look for "Momentum pyramid" in logs)
- Capital efficiency exits: positions should auto-sell at 99%+
- Smart money panel: MTM figures should update live
- Source performance divergence: does momentum outperform intel?

---

## v11 — Performance Mirror (Layer 1 Self-Recursion)
**Deployed**: 2026-02-16

### Problem
Opus produces daily probability estimates without ever seeing its own track record. It can't learn from systematic biases (overconfidence on release dates, underconfidence on policy events). All the calibration data exists in the DB but nothing feeds it back into the decision-making process.

### Changes

**Track record injection** — new `_build_track_record(conn)` in `intelligence.py` appends a `YOUR TRACK RECORD` section to the daily Opus intelligence prompt:
- **Open positions**: ID, side, question, vault estimate, confidence, entry edge, current market odds, unrealised P&L
- **Resolved positions**: W/L, P&L per bet, aggregate record (shown when pipeline bets close)
- **Calibration buckets**: 0-40% / 40-60% / 60-100% estimated probability vs actual YES rate, with over/underconfidence hints (shown after 3+ resolutions)
- **Smart money summary**: veto/boost counts and outcomes from `smart_money_log`

**Calibration guidance** — system prompt now instructs Opus to adjust estimates based on its track record patterns.

**Pipeline-era only** — filters on `entry_confidence > 0`, excluding legacy tool-loop bets (IDs 1-91) that would pollute feedback.

### Cost Impact
~200-500 extra input tokens per daily Opus call = ~$0.005/day.

### What to Watch
- Next Opus call (00:00 UTC): verify `YOUR TRACK RECORD` section appears in logs with open positions
- As positions resolve: RESOLVED and CALIBRATION sections should populate organically
- Watch for Opus adjusting estimates in response to track record feedback

---

## v10 — Smart Money Velocity
**Deployed**: 2026-02-16 | **Schema**: v10

### Problem
VAULT detects sharp price moves on Polymarket (5pp/1h or 10pp/6h) but barely acts on them — a timid -15%/+5% confidence adjustment. Sharp moves represent **informed money** (insiders, people with better information). If true, VAULT should follow smart money, not fight it.

### Changes

**Velocity veto** — sharp move AWAY from estimate → hard block the bet
- If not an open position: override `action = "hold"`, store counterfactual (what size/side WOULD have been)
- If open position: flag for exit with "Smart money exit signal" reasoning
- Logged as `veto` in `smart_money_log` table

**Velocity boost** — sharp move TOWARD estimate → +15% confidence (was +5%)
- Recalculate Kelly sizing with boosted confidence
- Logged as `boost` in `smart_money_log` table

**Momentum bets** — sharp move on unestimated market → Haiku analysis → small momentum bet
- Haiku (~$0.001/call) analyzes whether the move makes fundamental sense
- If confidence >= 50% AND edge >= 5%: create bet item capped at $2.00
- Flows through existing decider path as `source="momentum"`
- Logged as `momentum_bet` or `momentum_skip`

**Smart money log** — track every velocity-influenced decision with counterfactual P&L
- New `smart_money_log` table (schema v10) records every veto/boost/momentum decision
- Outcome resolution backfills when predictions resolve: veto_correct/veto_wrong with counterfactual P&L
- Hypothesis validation: after a few days, check if veto counterfactual P&L is net negative (= vetoes saved money)

**Configurable velocity thresholds** (`config/default.yaml`)
- `velocity` config section: sharp thresholds, veto enable, boost/haircut amounts, momentum params
- `calculate_velocity()` now reads thresholds from config instead of hardcoded 0.05/0.10

**Dashboard: Smart $ page**
- Summary bar: total vetoes/boosts/momentum bets/skips
- Hypothesis scorecard: "Vetoes saved $X" vs "Vetoes cost $X" — green if net positive
- Recent signals table with color-coded action badges and outcomes
- API endpoints: `GET /api/v1/smart-money/log` + `/summary`

### Cost impact
- Veto/boost logic: $0 (pure Python on existing data)
- Momentum Haiku calls: ~$0.001 each, ~1-5/day → ~$0.005/day
- Total additional: **~$0.005/day**

### Files modified
| File | Change |
|------|--------|
| `vault/db.py` | Schema v10, `smart_money_log` table + migration |
| `config/default.yaml` | New `velocity` config section |
| `vault/edge_calculator.py` | Veto + boost logic, `_log_smart_money_event()`, configurable thresholds |
| `vault/intelligence.py` | Pass cfg to `calculate_velocity()` |
| `vault/prompts.py` | `build_momentum_prompt()`, updated `_format_velocity_line()`, momentum in decider |
| `vault/agent.py` | Momentum pipeline, `_call_momentum_haiku()`, `_resolve_smart_money_entries()` |
| `vault/api.py` | `GET /api/v1/smart-money/log` + `/summary` endpoints |
| `dashboard/src/components/SmartMoneyPanel.jsx` | New dashboard page |
| `dashboard/src/hooks/useVaultData.js` | Fetch smart money summary |
| `dashboard/src/App.jsx` | Add nav + route for Smart $ page |

### What to watch
- First few days: are velocity alerts actually firing? Check `smart_money_log` table
- Veto effectiveness: are vetoes saving money? Compare `veto_correct` vs `veto_wrong` counts
- Momentum bets: are Haiku's snap analyses profitable? Track win rate + P&L
- False positive rate: are there markets with sharp moves that are just noise?
- Edge case: veto on open position → exit signal. Does the decider actually sell?

---

## v9 — Loosen the Gates
**Deployed**: 2026-02-15 | **Schema**: v9 | **First cycle**: 836 | **First bet**: cycle 845

### Problem
VAULT was sitting on $55 in cash with only 1 position open. Every discovered market failed either the edge gate (15%) or the confidence gate (0.4). The system was too conservative — Opus's stable daily estimates don't need the same cushion that noisy per-cycle Haiku estimates required. Additionally, markets with Opus estimates were silently dropped from edge calculations if keyword-based discovery didn't find them, meaning some of the best opportunities were invisible.

### Changes

**Lower `min_confidence` 0.4 → 0.3** (`config/default.yaml`, `edge_calculator.py`)
- Unlocks markets where Opus has moderate confidence but fat edges (e.g. Starship +15.5% edge, 0.35 conf)
- Kelly sizing already scales bet size with confidence — low confidence = small bet, risk is naturally managed
- The 0.4 threshold was set when Haiku was estimating per-cycle. Opus daily estimates are more trustworthy.

**Lower `margin_of_safety` 0.15 → 0.10** (`config/default.yaml`)
- v6 bumped from 10% to 15% to compensate for noisy Haiku estimates. v8's stable Opus estimates make that cushion unnecessary.
- 10% margin + 0.3 confidence + Kelly sizing = triple-layered protection.

**Track `entry_confidence`** (`db.py`, `ledger.py`, `actuators/bet.py`)
- New `entry_confidence REAL` column on predictions table (schema v9 migration)
- Every new bet records the Opus confidence at entry
- Enables future analysis: bucket P&L by confidence band to find the optimal threshold empirically

**Fix estimated markets missing from edge calculations** (`edge_calculator.py`)
- Opus estimated 7 markets but keyword discovery only found 4. The other 3 (including Starship) were silently skipped — no odds to calculate edge against.
- Edge calculator now fetches live odds for any estimated market not found by discovery.
- Also records odds snapshots for these markets, so velocity calculations and mark-to-market stay current. Previously, positions in undiscovered markets had stale snapshots (Netflix was 2 days old).
- Immediately triggered the Starship FT12 bet — the market that was supposed to pass both gates all along.

**Filter auto-hold from dashboard** (`api.py`, `CycleLog.jsx`)
- Auto-hold cycles ($0 cost, no action) were flooding the Recent Decisions panel
- Filtered server-side in SQL (`WHERE reasoning NOT LIKE 'auto-hold:%'`) so the API only returns actionable decisions

### Baseline at deployment (cycle 836)
- Balance: $55.27 | Total value: $62.97
- 1 open position (Netflix/WB NO, $7.57)
- API costs: $8.76 | Alive: 3.4 days

### Result
- Starship FT12 YES bet placed immediately (cycle 845): $5.00 at 46% odds, 16% edge, 0.35 confidence
- 2 positions open, $12.57 deployed (~20% of total value)
- Total value: $63.10 (+26.2% from $50 seed)

### Files modified
| File | Change |
|------|--------|
| `vault/edge_calculator.py` | Lower default min_confidence 0.4→0.3, fetch odds for estimated markets missed by discovery |
| `vault/db.py` | Schema v9: add `entry_confidence` column, migration |
| `vault/ledger.py` | Accept + store `entry_confidence`, include in `get_open_predictions` |
| `vault/actuators/bet.py` | Pass confidence from pipeline edge data to ledger |
| `config/default.yaml` | `margin_of_safety` 0.15→0.10, `min_confidence` 0.4→0.3 |
| `vault/api.py` | Filter auto-hold cycles from `/api/v1/cycles` endpoint |
| `dashboard/src/components/CycleLog.jsx` | Clean empty state message |

### What to watch
- **Starship FT12**: first bet under new thresholds — does 0.35 confidence produce good outcomes?
- **New bets after Opus update**: 00:00 UTC refresh may shift confidences and unlock more markets
- **Capital deployment**: should increase from ~12% to ~20-30% as more edges pass the gates
- **P&L by confidence band**: once trades resolve, bucket by `entry_confidence` to find optimal threshold
- **Discovery gap**: the odds-fetch fallback adds API calls — watch for rate limiting on Polymarket

---

## v8.4 — Git-backed Intelligence History
**Deployed**: 2026-02-15

### Problem
The `master_intelligence` table appended a full copy of the document (~8-13k chars) on every Opus update. Only the latest row is ever read — the rest is dead weight. 8 rows in one day = 55k chars of duplicated text. No way to see what actually changed between versions.

### Fix
The master doc now lives as a file in a dedicated git repo on the VPS, pushed to GitHub after each update. GitHub provides free diff visualization, full history, and storage efficiency. The DB keeps a single row for the pipeline to query quickly.

- **Git repo**: `hdonovan42/vault-intelligence` (private) — `/home/hq/vault/intelligence/` on VPS
- **`_git_commit_intelligence()`**: New helper writes `master_intelligence.md` + `themes.json` to git, commits with tweet count + cost, pushes to GitHub. Wrapped in try/except — git failure never breaks the pipeline.
- **DB pruning**: After each INSERT + git commit, old rows are deleted (`DELETE WHERE id < MAX(id)`). Orphaned `opus_estimates` rows pruned too.
- **Deploy safe**: `intelligence/` added to rsync excludes so deploy's `--delete` doesn't wipe the git repo.

### Files modified
| File | Change |
|------|--------|
| `vault/intelligence.py` | Add `_git_commit_intelligence()`, call after INSERT in `update_intelligence()` and `seed_intelligence()`, prune old DB rows |
| `deploy/deploy.sh` | Add `--exclude 'intelligence/'` to rsync |

### What to watch
- GitHub repo: each daily Opus update should produce a new commit with a clean diff
- DB size: `SELECT COUNT(*) FROM master_intelligence` should always be 1
- Pipeline reads: unchanged — `get_latest_intelligence()` still returns the single row
- Deploy: `intelligence/` git repo must survive rsync `--delete`

---

## v8.3 — Intelligence Document Fixes
**Deployed**: 2026-02-15 | **First cycle**: 567+

### Problem
The master intelligence document — intended as a curated living briefing — was being destroyed on every update. Five emergency Opus rewrites in one day ($1.06 wasted) because the sentinel flagged routine tweets as "major events". Each rewrite produced a standalone report instead of updating the existing document. The original hand-crafted seed (8,021 chars) was completely discarded on the first Opus call. The final document had wrong dates, only referenced 1 tweet, and lost all prior analysis.

### Root causes
1. **Sentinel too trigger-happy**: Haiku flagged routine tweets (China AI film, jobs data) as `major_event`, triggering emergency Opus rewrites. Every single intelligence update today was sentinel-triggered, not the daily schedule.
2. **Opus prompt asked for a new report, not an edit**: The output instruction said "Updated ~500-800 word analysis covering..." — Opus treated this as a brief for a fresh report, not a surgical edit to the existing document.
3. **No date in prompt**: Opus hallucinated dates (wrote "Feb 18-19" when it was Feb 15) because the prompt never included the current date.
4. **No size constraint**: Without a cap, the document grew from 8k to 13k chars in one day. At that rate: ~480k chars in 3 months.
5. **max_tokens too low**: Original seed (8,021 chars) + edits + themes + estimates JSON exceeded the 4,096 token output limit, causing parse failures.

### Fixes
- **Sentinel `major_event` tightened** (`sentinel.py`): Now requires a confirmed event with direct impact on a tracked market or open position, significant enough to change a buy/sell/hold decision. Tracked markets list included in prompt for context. Explicit examples of what qualifies vs doesn't. Default: null.
- **Living document prompt** (`intelligence.py`): Opus now told to start from the existing text and make targeted edits. If 1-2 tweets came in, output should be ~95% identical to input. Never rewrite from scratch.
- **Current date injected** (`intelligence.py`): `CURRENT DATE/TIME: {now}` in system prompt. No more hallucinated dates.
- **Document size cap** (`intelligence.py`): Hard constraint of 1,500-2,000 words. Decay rule: developments >7 days with no new signals get compressed to one line or removed. Resolved events pruned entirely. Document should always read like a fresh briefing for today's decisions.
- **max_tokens 4096→8192** (`intelligence.py`): Enough room for the full document + themes + estimates JSON without truncation.
- **Original seed restored on VPS**: Backdated timestamp so all 39 accumulated tweets were incorporated in one update. Result: original seed preserved with new developments woven in surgically.

### Files modified
| File | Change |
|------|--------|
| `vault/sentinel.py` | Tightened `major_event` prompt, added tracked markets to context |
| `vault/intelligence.py` | Living doc prompt, current date, size cap, decay/prune rules, max_tokens bump |
| `vault/pipeline.py` | (no net change — cooldown added then removed) |

### What to watch
- Next daily Opus call (00:00 UTC): should compress the 13k doc back to ~8k while preserving current analysis
- Sentinel `major_event`: should stop firing on routine tweets — check logs for "MAJOR EVENT" lines
- Document continuity: subsequent updates should be surgical edits, not rewrites
- Document size over time: should stabilise at ~6,000-8,000 chars, not grow unbounded

---

## v8.2 — Odds Velocity Tracking
**Deployed**: 2026-02-15 | **First cycle**: TBD

### Changes
- **Velocity calculation**: New `calculate_velocity()` in `edge_calculator.py` computes 1h and 6h price deltas from existing `odds_snapshots` table. No new API calls — pure math on data already being collected every cycle.
- **Confidence adjustment**: When odds move sharply (5pp/1h or 10pp/6h) *away* from VAULT's estimate, confidence is reduced by 0.15 (market may know something). When moving *toward*, bumped by 0.05 (confirmation). Clamped to [0.1, 1.0].
- **Velocity in prompts**: Decider and edge prompts now show velocity lines (e.g. `Velocity: +8%/1h, +12%/6h (market moving toward your estimate)`) when data is available.
- **Velocity alerts**: Unestimated markets with sharp moves surface as `velocity_alert` edge results. These can't trigger bets (no estimate) but are logged and visible for the next daily Opus call.
- **Opus context**: Daily intelligence update now includes velocity data for each market being estimated (e.g. `[odds moved +12%/1h]`), giving Opus momentum context when forming probability estimates.

### Architecture
- **No new tables** — uses existing `odds_snapshots` populated by `market_discovery.record_odds_snapshot()` every cycle
- **No new API calls** — all velocity is computed from SQLite queries + arithmetic
- **No schema migration** — no changes to DB schema
- **Flow**: pipeline → Opus estimates (daily) → velocity calc (snapshot deltas) → edge calc (vault_prob vs market_odds + velocity) → decider

### What to watch
- Velocity data in edge calcs: check logs for "Velocity CAUTION" or "Velocity CONFIRM" in reasoning
- Confidence adjustments: verify sharp moves correctly reduce/increase confidence
- Velocity alerts: watch for "Velocity alert" log lines on unestimated markets
- Decider prompts: verify velocity lines appear in bet/exit sections
- Daily Opus: confirm velocity context shows in market estimation block
- No cost increase: all velocity is pure math ($0)

---

## v8.1 — Auto-Pilot Decider
**Deployed**: 2026-02-15 | **First cycle**: TBD

### Changes
- **Auto-hold on quiet cycles**: When the pipeline finds no actionable edges (no `bet` or `exit` signals, no sentinel BROKEN alerts), the cycle auto-holds with 0 rounds and $0 cost. No Claude call at all.
- **Single-shot decider**: When actionable opportunities exist, calls Haiku once with a focused JSON-only prompt (`build_decider_prompt`). No tool-use loop, no `research_markets` calls. Decider sees only the specific opportunities and responds with a JSON action array.
- **Direct actuator execution**: After parsing the decider's JSON response, the agent executes `BetActuator` or `SellPredictionActuator` directly with guardrail checks. No tool-use round-trip overhead.
- **Legacy fallback**: If the pipeline is disabled or fails, falls back to the original tool-use loop (`_run_tool_loop`) with full system prompt and tools. Ensures no regression if pipeline has issues.
- **Refactored agent.py**: Extracted `_get_actionable()` (scans pipeline edges + sentinel for actionable items), `_run_decider()` (single-shot Haiku call + execution), `_run_tool_loop()` (legacy path), and `_parse_decider_json()` (tolerant JSON parser).

### Architecture
- **Auto-pilot flow**: pipeline → `_get_actionable()` → NO items → auto-hold ($0.00) | YES items → `build_decider_prompt()` → Haiku 1 round no tools → execute ($0.005)
- **Cost savings**: ~90% reduction in decider spend. Normal cycles (no edges) cost $0 instead of ~$0.019.

### Cost Projection
| Scenario | v8 | v8.1 |
|---|---|---|
| Normal cycle (no edges) | $0.019 | $0.00 |
| Cycle with bet/exit | $0.019 | ~$0.005 |
| Daily Opus call | $0.25 | $0.25 |
| Sentinel (when tweets) | $0.001 | $0.001 |
| **Daily total (est.)** | **~$2.85** | **~$0.40** |

### What to watch
- Auto-hold cycles: should appear as action="hold", cost=$0, rounds=0
- Decider JSON parsing: check logs for parse errors on actionable cycles
- Bet/sell execution: verify actuators fire correctly from decider path
- Fallback path: if pipeline disabled, tool loop should still work normally
- Burn rate: should drop from ~$2.85/day to ~$0.40/day

---

## v8 — Stable Opus Estimates + Haiku Sentinel
**Deployed**: 2026-02-15 | **First cycle**: 423

### Changes
- **Opus probability estimation**: Moved probability estimation from per-cycle Haiku calls to the daily Opus intelligence update. Opus estimates are stable across cycles (updated once daily), eliminating the noise that caused premature exits. Estimates stored in new `opus_estimates` table.
- **Haiku sentinel**: New per-cycle sentinel module replaces Haiku estimator. Binary thesis monitoring (INTACT/BROKEN) instead of noisy probability estimation. Only fires when new tweets exist. Also detects major events that trigger emergency Opus re-estimation.
- **Sentinel exit condition**: New highest-priority exit trigger — when the sentinel detects concrete evidence breaking an open position's thesis (official announcements, regulatory decisions, confirmed cancellations), it triggers immediate sell.
- **Emergency Opus re-estimation**: When sentinel detects a major event (product launch, regulatory action, policy decision), triggers an out-of-schedule Opus update + fresh estimates.
- **Removed per-cycle Haiku estimation**: Eliminates ~144 Haiku estimator calls/day (~$0.50-0.70/day). Replaced with ~100 sentinel calls (~$0.10/day, many skipped when no new tweets).
- **Removed per-market relevance filtering**: No longer needed — Opus gets raw tweets directly, sentinel gets delta tweets only.
- **Schema v8**: New `opus_estimates` table (intelligence-linked estimates) and `sentinel_alerts` table (BROKEN thesis records).
- **New API endpoints**: `GET /api/v1/opus-estimates` and `GET /api/v1/sentinel/alerts`.
- **Dashboard**: Shows sentinel alerts (red, breaking) and Opus estimate source (model, timestamp).

### Architecture
- **Daily Opus call** (00:00 UTC): intelligence document + themes + probability estimates for all discovered markets + open positions. Single call, stable output.
- **Per-cycle flow**: collect tweets → sentinel scan (Haiku, ~$0.001) → load Opus estimates (free) → edge calculation (math, free) → decider (Haiku, ~$0.002).
- **Cost**: ~$0.15/day (sentinel) + ~$0.20/day (Opus daily) = ~$0.35/day total, down from ~$0.70/day.

### Baseline at deployment (cycle 423)
- Balance: $36.06 | Total value: $72.95
- API costs: $6.31 | Alive: 3.0 days
- Realized P&L: +$25.33
- 3 open positions, 8 Opus estimates from first manual run

### Problem this solves
- 87 closed positions, ALL sold early, 38 with zero P&L, average hold time ~2 hours.
- Root cause: Haiku gives wildly different probability estimates cycle-to-cycle with identical information. Exit conditions compare current vs entry estimates, so random noise crosses thresholds even when nothing changed.
- Fix: Opus estimates are stable (updated daily), so exit conditions only fire when Opus genuinely changes its mind. Sentinel handles breaking news exits with binary clarity.

### What to watch
- Hold duration: should increase dramatically from ~2h average
- First market resolution (won/lost): positions should now ride to completion
- Sentinel false positive rate: should be near zero (conservative prompt)
- Opus estimate quality: daily cadence should produce well-calibrated, stable estimates
- Cost per day: should drop from ~$0.70 to ~$0.35

---

## v7 — Opus Master Intelligence + Raw Tweet Pipeline
**Deployed**: 2026-02-15 | **Commit**: `f51ee06` | **First cycle**: 414

### Changes
- **Master intelligence document**: Replaces rolling Haiku digest with a single Opus-maintained analysis document, updated once daily at 00:00 UTC. Covers key developments, narrative arcs, source credibility, and prediction market implications (~500-800 words).
- **Raw tweets to estimator**: Full raw tweets from last 24h (grouped by curated account) now passed directly to the Haiku estimator alongside the master doc. Previous approach compressed ~185 tweets into ~300 words of generic digest, destroying signal.
- **Removed per-cycle theme extraction**: Themes now come from the daily Opus update (stored in `master_intelligence.themes_json`). Eliminates 144 Haiku calls/day (~$0.24/day).
- **Removed per-cycle digest generation**: No more rolling Haiku digest every 4h. Eliminates ~6 Haiku calls/day (~$0.012/day).
- **Daily Opus call**: ~$0.15-0.25/day. Net savings ~$0.05/day with dramatically better analytical quality.
- **Estimator context**: Now sees "MASTER INTELLIGENCE" (strategic) + "RAW TWEETS" (granular evidence) instead of compressed digest. First cycle showed 10,174 input tokens.
- **Decider context**: Sees master doc + themes + edge results. Does not see raw tweets (estimator already processed them).
- **Schema v7**: New `master_intelligence` table. Seeded via `vault seed-intel` CLI command.
- **Two-layer architecture**: Opus provides the analytical framework (what matters, who to trust, what's tradeable). Haiku estimator applies it against raw evidence per cycle.

### Baseline at deployment (cycle 414)
- Balance: $30.74 | Total value: $69.70
- API costs: $6.11 | Alive: 2.9 days
- Realized P&L: +$25.85
- 12 themes from initial seed document

### What to watch
- Estimator quality: are probability estimates better-calibrated with raw tweet access?
- Theme relevance: does daily Opus produce better themes than per-cycle Haiku extraction?
- Cost per day: should drop from ~$0.50/day to ~$0.25/day on intelligence pipeline
- Edge detection: does richer context find more/better edges?
- First Opus update: will fire at 00:00 UTC — verify it runs and produces good output

---

## v6 — Intelligence-Driven Discovery + Sell Discipline
**Deployed**: 2026-02-14 | **Commit**: `65c2640` | **First cycle**: 275

### Changes
- **Theme extraction**: Haiku call reads digest, extracts event-driven themes with keywords. Replaces hardcoded keyword list (`Tesla, SpaceX, Elon, Musk, xAI, Neuralink, Starship`). System prompt explicitly excludes statistical/counting markets.
- **Market discovery**: Filters Polymarket bulk fetch against theme-derived keywords instead of static list. Falls back to config keywords if no themes found.
- **Sell discipline rewrite**: Removed "edge evaporated" exit trigger (was firing when market agreed with us — killing winners). New exit triggers: (a) estimate flipped against position (<45%, confidence >=50%), (b) estimate dropped to <50% of entry estimate, (c) remaining EV < risk-free AND < $0.50.
- **Entry thesis stored**: Schema v6 adds `entry_edge` and `entry_reasoning` to predictions table. Bet actuator stores pipeline edge data at entry time.
- **Margin of safety**: 10% → 15%
- **Estimator calibration**: Prompt now tells Claude to assign 0.2-0.3 confidence to statistical/counting markets.

### Baseline at deployment (cycle 275)
- Balance: $33.22 | Total value: $75.07
- 70 closed bets: ALL sold early, 0 resolved (won/lost)
- Closed P&L: +$31.66 (dominated by one EPA event bet: +$48.64)
- 5 open positions (including legacy tweet-count markets)
- API costs: $3.80 | Alive: 1.9 days

### What to watch
- Sell frequency: should drop dramatically (was 100% early exit)
- Market type distribution: tweet-count/statistical markets should stop appearing in new bets
- Hold duration: should increase significantly from 2.1h average
- First resolution (won/lost): has never happened — this is the key milestone

---

## v5 — Rolling Digest + Per-Market Relevance
**Deployed**: 2026-02-14 | **Commit**: `db4e176` | **First cycle**: ~257

### Changes
- Rolling tweet digest: single evolving Haiku-generated briefing, revised every 4h with new tweets. Old context compressed, not dropped.
- Per-market relevance filtering: keyword matching finds tweets relevant to each specific market question before estimation.
- Digest shown in estimator prompt as "INTELLIGENCE BRIEFING".

---

## v4 — Risk-Free Return Gate
**Deployed**: 2026-02-14 | **Commit**: `6b04b3e` | **First cycle**: ~240

### Changes
- New bets must have expected profit exceeding the risk-free return on the same capital over the market duration.
- Prevents marginal bets where tiny edge doesn't justify capital lock-up.

---

## v3 — Curated X Feed
**Deployed**: 2026-02-13 | **Commit**: `295a4a9` | **First cycle**: ~200

### Changes
- Restricted X/Twitter feed to curated accounts only (elonmusk, SawyerMerritt, farzyness, TeslaLarry, jamesdouma). Removed keyword search.
- Tracked `retweeted_by` field for retweets.
- Reduced noise in tweet collection.

---

## v2 — Edge-Based Pipeline
**Deployed**: 2026-02-13 | **Commit**: `e2c8f34` | **First cycle**: ~150

### Changes
- Full pipeline: collect tweets → discover Musk markets → estimate probabilities (blind to odds) → calculate edges → Kelly sizing.
- Hardcoded keyword matching: `Tesla, SpaceX, Elon, Musk` against Polymarket bulk fetch.
- Edge calculator with margin of safety (10%), Kelly fraction, confidence weighting.
- Exit analysis for open positions: edge evaporated, remaining EV negligible, estimate flipped.
- Pipeline result feeds into system prompt (replaces generic market browsing).

---

## v1 — Base Agent
**Deployed**: 2026-02-12 | **Commit**: `2c69ea9` | **First cycle**: 1

### Changes
- Initial deployment. Haiku agent with tool-use loop.
- Research markets → bet/hold/wait decision.
- $50 seed balance, 15-min cycle interval.
- No pipeline, no edge detection, no digest.
