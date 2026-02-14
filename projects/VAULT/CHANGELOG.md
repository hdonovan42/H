# VAULT Algorithm Changelog

Track every change to the pipeline and decision-making algorithm.
Correlate cycle ranges with performance to identify what works.

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
