# VAULT Trading Lessons

## $50 Real-Money Loss Post-Mortem — 15 March 2026

**TL;DR.** First real-money run lost the full $50 seed. Two compounding bugs: (a) flipping `simulated: false` preserved the $51.29 paper-ledger balance as if it were real money, and (b) `check_balance_divergence()` silently passed whenever the Polygon RPC was unavailable, so the daemon kept trading blind for hours. A third, older bug — `buy_shares()` passing a plain dict instead of `MarketOrderArgs` — made the first few hours of orders visibly fail; once that was fixed in v19.3, orders started succeeding on-chain. Some orders (count unknown — DB was wiped on 17 March) were not recorded in `predictions` because the CLOB order → DB write was not atomic: on exception between the two, the on-chain position orphans and the daemon has no idea it holds shares. Those orphans resolved without exits being placed and the $50 drained to zero.

### Timeline (UTC)
- **15 Mar 00:38** — `simulated: false` flipped; daemon restarted. Internal paper ledger: $51.29. On-chain USDC: $0. Wallet used was Opus 4.6's Polymarket wallet.
- **15 Mar 00:38–00:40** — RPC calls fail: `polygon-rpc.com` returns 401, `polygon.llamarpc.com` DNS failure, Ankr demands API key. `get_usdc_balance()` returns `None`; code treats this as "carry on."
- **15 Mar 00:52** — First `Negative balance drift: -$51.29` WARNING. No auto-pause — `check_balance_divergence()` short-circuits when `onchain is None`.
- **15 Mar 01:13–~06:00** — Dozens of `POST /order` calls. All return `400 invalid signature` (the `MarketOrderArgs` dict bug, pre-v19.3). No fills, but also no halt.
- **15 Mar 00:41 (commit) → later same day (deploy)** — v19.3 (`e9a7678`) fixes the dict bug AND adds USDC deposit auto-detect (`_reconcile_balance`). Both changes bundled.
- **15 Mar (exact time lost)** — Real $50 deposited. Orders start succeeding. Some bets land on-chain; at least some are not recorded in `predictions` (exception path in `bet.py` between CLOB success and `record_prediction_buy` — no rollback, no pre-record).
- **15–17 Mar** — Unrecorded positions resolve without exits, cash drains to ~$2.67.
- **17 Mar 17:04** — DB wiped and re-seeded at $2.67. Lost bet records cannot be recovered from journalctl beyond order POST attempts.

### Root causes (ordered by blast radius)
1. **Paper→real transition preserves phantom balance.** Paper P&L accumulated over 29 days was inherited as real spendable balance on mode flip. There is no "reset ledger to match on-chain" step. (PRIMARY CAUSE of the $50 loss — even if every other bug had been absent, the daemon would still have tried to spend $51.29 of imaginary money.)
2. **RPC-unavailable silently passes divergence check.** `check_balance_divergence()` returns `(False, "RPC unavailable")` when `get_usdc_balance()` is `None`. Daemon treats as "OK to trade." A daemon that cannot verify on-chain state must not trade.
3. **Single RPC provider, no fallback.** One `polygon_rpc_url` config value. Any 401, DNS failure, or rate-limit blinds the whole system.
4. **CLOB order → DB write is not atomic.** `bet.py` places the order, then writes to DB. On exception between them, the on-chain position orphans. No rollback, no pre-recording, no reconciliation sweep.
5. **Stale paper balance accepted by bet gate.** `check_trade_allowed()` compares amount to ledger balance. In real mode, this must ALSO compare to on-chain USDC, not just the internal ledger.
6. **Shared wallet for paper and real.** The same wallet Opus 4.6 created was used for the first real run — no clean handover, no separate production wallet.

### Never-again rules (enforced by code, not discipline)
1. Going to real mode is a **deliberate CLI action** (`vault go-live`), not a config flip. It zeros the paper ledger, snapshots on-chain USDC, seeds with the real balance, and writes a `go_live` event.
2. `vault start` in real mode **refuses to start** if the ledger has no `go_live` event or if on-chain verification fails.
3. Balance divergence check treats **repeated RPC failure as divergence** — auto-pause after N consecutive `None` returns.
4. RPC has a **multi-provider fallback list**; each provider retried once before giving up.
5. **Pre-record pending bet BEFORE the CLOB call.** Row inserted as `status='pending'`. On CLOB success → `status='open'` + ledger entry in same transaction. On exception → row stays `pending` and reconciliation sweep decides fate next cycle.
6. **Post-trade CTF balance verification.** After CLOB reports success, confirm shares arrived on-chain. If not, auto-pause.
7. **Orphan-position sweep** runs at startup and every N cycles: scan on-chain CTF balances for known token_ids, flag any mismatch vs DB.
8. **Real-mode position cap**: max single bet = `min(config_max, on_chain_usdc * 0.10)`. A bug can never nuke more than 10% in one shot.
9. **Fresh wallet for each major re-arm.** The `vault go-live` command accepts a wallet address and refuses to re-use one associated with a previous `go_live` event that ended in loss.
10. **Reinjection checklist.** `vault verify-live` exits non-zero unless: CLOB client signs a dummy message, USDC balance fetched via fallback RPCs, allowances set, no open real predictions from a prior life, `compute_expected_onchain()` matches `get_usdc_balance()` ± tolerance.

---

## Pyramid Add Post-Mortem — 2 March 2026

**Finding:** Pyramid adds are the sole source of negative P&L. 342 adds lost -$33.97 against +$48.56 from initial entries. Without adds, total P&L would be +$48.38 instead of +$14.41.

**Root causes:**
1. **Concentration**: Up to 16 adds to a single market. Tiafoe match (7 adds, $54) lost $29.54.
2. **Multiplicative sizing**: Pyramid mult (3x) × velocity mult (2x) = 6x base bet.
3. **No independent validation**: Adds used synthetic 0.8 confidence, skipping Haiku entirely.
4. **Prediction markets mean-revert**: Unlike equities, adding at +30% ROI means buying at worse prices with less upside.
5. **Trivial gate**: Only 2% ROI and 10-min cooldown allowed rapid stacking.

**Action:** Pyramid adds disabled entirely. Shadow A/B testing system deployed with two variants (strict/relaxed) to validate any future rework before re-enabling.

**Lesson:** Prediction market momentum is profitable for initial entries but anti-profitable for pyramiding. The concept of "add to winners" from equity trading does not transfer to binary outcome markets where prices converge to 0 or 1 at resolution.

---

## 48h Analysis — 1 March 2026

**Dataset:** 844 trades | -$1.58 net P&L | $2,453 cost basis | $93 total value (from $50 seed)
**Period:** 27 Feb 15:55 – 1 Mar 15:55 UTC
**Analysts:** 4 parallel agents (wins/losses × prior/recent 24h) + synthesiser with cross-debate

---

### Actionable Changes (ranked by expected P&L impact)

| # | Change | Config / Code | Current | Proposed | Expected +P&L/48h | Risk of Lost Profit (1=high) |
|---|--------|---------------|---------|----------|-------------------|------------------------------|
| 1 | Per-market add cooldown | Code: track `last_add_time` per market+side | None | 10-min gate between adds | +$40–50 | 5 — Profitable adds are naturally spaced (Musk cluster: minutes apart but across different markets). Rapid-fire same-market stacking is almost never correct; 3 clusters totalling -$57 prove the pattern. Negligible upside risk. |
| 2 | Tighter trailing stop (sports/near-resolution) | `trailing_stop_min_peak` / `trailing_stop_drop` | 0.15 / 0.15 | 0.10 / 0.10 for live sports + odds >0.75; keep 0.15/0.15 for geo-political/crypto | +$25–40 | 3 — Sports markets resolve fast and irreversibly, so tighter stops suit them. But geo-political markets have noisier price action where dips recover — applying universally would clip winners. Category differentiation mitigates this, but edge cases (a sports market with a genuine second-half comeback) will get stopped out prematurely. |
| 3 | Hard-block burned markets | Code: early return when guard fires + lower threshold | Labels only, threshold -$2.00 | Hard block + -$1.50 for sports | +$10–15 | 2 — Highest upside risk. Markets that burned us once can genuinely reverse (mean-reversion plays, late-breaking news). Hard-blocking means we can never "buy the dip" on a market where we lost early. The Palantir cluster (-$13.05) shows the guard is needed, but a blanket block could miss recovery entries. Consider a cooldown (e.g. 30 min) rather than permanent block within the 4h window. |
| 4 | Raise add ROI floor | `momentum_add_min_roi` | 0.02 (2%) | 0.06 (6%) | +$15–20 | 4 — Low-ROI adds (2–6% bucket) are the noise zone — the position has barely moved, signal strength is ambiguous. Raising to 6% still preserves the high-conviction adds (22% avg ROI) that drive pyramiding profits. Small risk of missing an early add on a fast mover, but the velocity check at add time compensates. |
| 5 | Block weather/novelty markets | `momentum_min_volume` (category-aware) | 5000 (uniform) | 15000 for non-core categories | +$8–12 | 5 — These markets are consistently the worst performers across both periods. Weather: -$20.37 in recent 24h alone. "Other" category: 6.9% ROI (worst by far). Momentum signals on temperature forecasts are genuinely meaningless. Zero upside sacrificed. |

**Risk ranking key:** 1 = highest risk of limiting profitable trades, 5 = lowest risk

---

### Consensus Findings

1. **Momentum adds are the dominant loss vector.** Adds generated 81–82% of all losses across both periods. Avg loss per add: -$1.27 vs -$0.475 for initial follows (2.7x worse). But they also produce the best ROI when they work (22.2% vs 3.1% for initials). The problem is execution speed, not the strategy itself.

2. **Burned-market guard is cosmetic.** Trade ID 1635 entered with `[BURNED MARKET]` tag but still executed. NYC weather traded both YES and NO simultaneously. The guard annotates but does not block.

3. **Trailing stop is misconfigured for sports.** The 15pp peak + 15pp drop combination lets live sports positions round-trip from +41% to -$7.05 (XRP ID 2092). 24 trades peaked ≥15% then ended as losses — $54.08 theoretical save.

4. **Weather/novelty markets waste capital allocation slots.** Seoul weather: -$15.17 (5 trades). NYC weather: -$4.08 (8 trades, traded both sides). "Other" category: worst ROI by every metric across both periods.

---

### Debate Resolutions

**"Hold winners longer" vs "Exit faster"** — Both are right for different market types. Sports resolve fast → tighter stops. Geo-political is noisy → let winners breathe. Single universal setting fails both.

**"More pyramid adds" vs "Fewer adds"** — The wins analyst wins on mechanism. Problem is speed (4 adds in 3 min) not volume. A 10-min cooldown preserves the profitable adds while blocking the rapid-fire disasters.

**"Raise velocity floor" vs "Keep sports floor low"** — Keep the 5% sports floor. Esports (29.9% ROI) and cricket (61.5% ROI) prove it works. The tennis problem is position persistence across cycles, not velocity.

---

### What NOT to Change

- **Pyramiding strategy** — 22% ROI vs 3% for initials. The edge is real.
- **Stale exit asymmetry** — 3h profitable / 30min losing. The 2–3h window is the profit sweet spot.
- **Sports velocity floor (5%)** — Best-performing categories use this floor.
- **Exposure caps** — `max_exposure 50%`, `max_positions_per_market 5`. Doing real work preventing worst-case concentration.
- **Musk ecosystem coverage** — 83% avg ROI, $22.56 from 5 trades in a single period. Genuine intelligence edge.

---

### Evidence (trade IDs)

| Pattern | Trade IDs | Loss |
|---------|-----------|------|
| Tiafoe rapid-fire adds (3.4 min) | 1371–1374 | -$29.54 |
| XRP rapid-fire adds (4 min) | 2092–2095 | -$16.30 |
| Cricket rapid-fire adds (~10 min) | 1605–1609 | -$11.16 |
| Palantir burned-market compound | cluster | -$13.05 |
| Seoul weather (5 NO trades) | cluster | -$15.17 |
| NYC weather (both sides) | cluster | -$4.08 |
| Antalya tennis compounding | 1878–1881 | -$9.25 |
| XRP peak 41% → loss | 2092 | -$7.05 |
| Burned-market tag ignored | 1635 | -$3.88 |
