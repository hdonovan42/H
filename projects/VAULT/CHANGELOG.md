# VAULT Algorithm Changelog

Track every change to the pipeline and decision-making algorithm.
Correlate cycle ranges with performance to identify what works.

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
