# VAULT Algorithm Changelog

Track every change to the pipeline and decision-making algorithm.
Correlate cycle ranges with performance to identify what works.

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
