# VAULT Algorithm Changelog

Track every change to the pipeline and decision-making algorithm.
Correlate cycle ranges with performance to identify what works.

---

## v20.6 — CLOB protocol v2 support

**Baseline**: 84/84 tests green. Daemon paused 3 days while every order was rejected with `order_version_mismatch`.

### What this fixes
Polymarket migrated their CLOB API from v1 to v2 in late April 2026 (`GET /version` now returns `{"version": 2}`). Our installed `py-clob-client` (0.34.6) still builds v1 orders, which the new server rejects with `order_version_mismatch`. The TS SDK got v2 support in their `clob-client-v2` repo two weeks ago; the Python SDK hasn't shipped it.

The v2 spec changes (sourced from `clob-client-v2/src/order-utils/model/ctfExchangeV2TypedData.ts` and `exchangeOrderBuilderV2.ts`):

| | v1 | v2 |
|---|---|---|
| EIP-712 domain version | `"1"` | `"2"` |
| verifyingContract (regular) | `0x4bFb41d5...` | `0xE111180000d2663C0091e4f400237545B87B996B` |
| verifyingContract (neg-risk) | `0xC5d563A3...` | `0xe2222d279d744050d28e00520010520000310F59` |
| Order struct | salt, maker, signer, taker, tokenId, makerAmount, takerAmount, side, expiration, nonce, feeRateBps, signatureType (12 fields) | salt, maker, signer, tokenId, makerAmount, takerAmount, side, signatureType, timestamp, metadata, builder (11 fields) |

Different domain version + new verifying contracts + new order schema means our v1-signed orders can't be recovered to a valid signer by the new server-side validators.

### Files added/modified
| File | Changes |
|------|---------|
| `vault/clob_v2.py` (new) | `build_signed_order_v2()` constructs the v2 EIP-712 order struct (Polymarket CTF Exchange / version "2", new verifying contracts) and signs via `eth_account.sign_typed_data`. `post_order_v2()` POSTs to `/order` with the existing L2 HMAC headers from `py-clob-client` (auth flow didn't change). Reuses py-clob-client for everything else: API key derivation, neg_risk lookup, tick size, fee rate, market-order amount calculation. |
| `vault/clob_client.py` | `buy_shares` and `sell_shares`: still call `client.create_market_order(...)` to compute correct maker/taker amounts (rounding, neg_risk auto-detect, fee rate), but extract `.dict()` and re-sign as v2 instead of posting v1. The response shape from `/order` didn't change, so the stealth-fill detection and CTF poll logic from v20.1 work unchanged. |
| `tests/test_clob_v2.py` (new) | 8 unit tests: domain version is "2", new exchange addresses, JSON shape correct, side handled, invalid side rejected, salts unique per call, neg-risk vs regular produce different signatures (proving different domain hashing), end-to-end signature recovers to signer address. |
| `tests/test_clob_stealth_fill.py` | Updated mocks to target the new v2 path (`vault.clob_v2.post_order_v2` instead of the old `client.post_order`). All 4 stealth tests still green. |

### What we deliberately kept from py-clob-client
- L1 auth (API key derivation via signing a ClobAuthDomain message).
- L2 auth (HMAC-SHA256 with API secret per request) — `create_level_2_headers` is reused verbatim.
- `client.get_neg_risk(token_id)` for auto-detecting neg-risk markets.
- `client.create_market_order(args)` for tick-size + rounding + fee-rate calculations. We extract its v1 SignedOrder via `.dict()` and re-sign for v2.
- All non-order endpoints (book, tick-size, neg-risk, fee-rate, balances/allowances).

### Why not subprocess to the TS SDK
Considered. Rejected: extra dependency surface (Node + JS), JSON IPC overhead, harder to test in our existing Python pytest suite, and the v2 spec is small (11 fields, one EIP-712 domain) so native Python is maintainable.

### Future-proofing
The v2 PR description mentions: *"Adds flow to refresh client version and retry posting orders if clob reverts for order mismatch"*. We don't have that yet — if Polymarket migrates to v3 the same break recurs. A follow-up could call `GET /version` at startup and route to v1/v2/v3 builders accordingly. For now we hardcode v2.

---

## v20.5 — Stop silent 50/50 fallback when gamma API has no outcomePrices

**Baseline**: 76/76 tests green. Pred #12 `peak_roi` reset from bogus 1.462 to 0.0; 17 polluted snapshots removed; `peak_total_value` reset from $22.11 to $19.99.

### What this fixes
The user observed pred #12 (Lakers NO) flickering: down 57c → up to +146% → back down 57c. Investigation showed the actual market never moved that much — the data feed did. For ~20 minutes after the daemon resumed (12:16–12:30 UTC on 2026-04-28), the Polymarket gamma API returned market records without `outcomePrices` populated. `_parse_market` had a silent fallback:

```python
yes_price = 0.5
no_price = 0.5
if outcome_prices:
    ...
```

So 17 odds_snapshots got written with bogus 50/50 readings. Those poisoned downstream:
- `predictions_value` (showed $2.54 vs real $0.50)
- `peak_roi` for pred #12 (pinned to +146.2% — would have skewed every future trailing-stop check)
- `peak_total_value` ($22.11 vs real $19.99)

Looking at the live logs after the fix: this isn't a one-off. **Every cycle, ~6 different markets** come back from the gamma API without prices. Silent 50/50 defaults were corrupting the snapshot history every minute, just rarely landing on a market we care about.

### Files modified
| File | Changes |
|------|---------|
| `vault/polymarket.py` | `_parse_market` no longer defaults to 0.5/0.5. Sets `yes_price = no_price = None` and adds a `has_prices: bool` flag to the parsed dict. `get_current_odds` returns `None` (with a WARNING log) when `has_prices` is False. |
| `vault/market_discovery.py` | Skips `_upsert_market` and `record_odds_snapshot` for markets without prices. Comparison `yes < 0.05` would otherwise crash on `None`. |
| `tests/test_polymarket_parser.py` (new) | 7 regression tests covering: prices-present happy path; missing/null/unparseable/short outcomePrices; `get_current_odds` returning None when has_prices=False; returning prices when present. |

### Data fix on live DB
- Deleted 17 bogus 50/50 odds_snapshots for market 1970316 between 12:15 and 12:35 UTC.
- Reset `predictions.peak_roi` for pred #12 from 1.462 to 0.0.
- Reset `meta.peak_total_value` from 22.106474 to 19.985 (current real total value).

### Knock-on benefits
Existing callers (`agent.record_objectives`, `api/v1/status`, `guardrails.check_drawdown`) already handled `odds is None` correctly (fall back to cost_basis / skip update). So returning None from `get_current_odds` Just Works for them. No additional caller changes needed.

---

## v20.4 — Wallet sync mustn't double-count redemption inflows

**Baseline**: drift back to $-0.0007 after reversal, 69/69 tests green.

### What this fixes
Several hours after the Pereira redemption tx (`0xfc598d9b...`) landed on-chain, the periodic `wallet_sync` reconciler scanned the new blocks and saw a `Transfer` event delivering $2.29 USDC.e from `0x3a3bd7bb9528e159577f7c2e685cc81a765002e2` (the Polymarket neg-risk collateral vault) to our wallet. The counterparty wasn't in `INTERNAL_ADDRESSES`, so it was logged as an external **deposit** — adding ledger entry #283 (+$2.29) on top of the `prediction_resolve` credit (+$2.29) already written by v20.2. Result: ledger thought we had $21.86, wallet had $19.77, **dashboard reconciliation panel reported $-2.29 drift**.

### Files modified
| File | Changes |
|------|---------|
| `vault/wallet_sync.py` | Added two addresses to `INTERNAL_ADDRESSES`: NegRiskAdapter (`0xd91E80c...`) and the neg-risk collateral vault (`0x3a3bd7b...`). Both are sources of redemption inflows for neg-risk markets and must not be treated as external counterparties. |
| `tests/test_wallet_sync.py` | New `test_is_internal_detects_neg_risk_redemption_sources` regression test pinned to the exact addresses involved in the Pereira incident. |

### Recovery
- Deleted ledger entry #283 (phantom deposit) and `wallet_transactions` row #3 from the live DB.
- Drift restored to $-0.0007 (rounding).
- Dashboard reconciliation panel now reports `status: ok`.

### Why this slipped through v20.2
The redemption module was tested with mocked `redeem_prediction` / mocked on-chain calls. The wallet_sync interaction wasn't covered because it runs on a separate cycle interval and only sees the on-chain state, not the prediction lifecycle. A future refactor should let wallet_sync correlate Transfer events with our own outbound tx hashes — but addresses-as-internal-filter is the scalpel for now.

---

## v20.3 — Backfill the missing shadow_trades table (latent bug surfaced post-Lakers entry)

**Baseline**: 68/68 tests green, drift $-0.0007 on-chain.

### What this fixes
After pred #12 (Lakers NO) was placed under v20.1, every subsequent cycle threw `no such table: shadow_trades` from `_evaluate_shadow_variants`. The shadow-pyramid feature was enabled in config and `agent.py` SELECT/INSERT-ed against the table, but no `CREATE TABLE` had ever been added to the schema. The daemon caught the exception per-cycle so it didn't crash, but the rest of momentum analysis silently bailed — every cycle after the first open position became a no-op.

### Files modified
| File | Changes |
|------|---------|
| `vault/db.py` | Added `shadow_trades` to `SCHEMA_SQL` for fresh installs; added v22 migration for existing DBs; bumped `SCHEMA_VERSION` to 22. Indexes on `(market_id, side, variant)` and `resolved`. |

### Notes
- This was a pre-existing bug unrelated to the v20.1/v20.2 work, but the same Lakers entry that proved v20.1 worked also tickled this hole. Surfacing it counts.
- Migration is non-destructive (`CREATE TABLE IF NOT EXISTS`); safe to apply on any DB regardless of how the existing daemon was running.

---

## v20.2 — On-chain redemption (closing the resolve→redeem gap)

**Baseline**: 68/68 tests green, daemon running real-money.

### What this fixes
v20.1 exposed a second gap during the Pereira recovery: when a real-mode prediction resolves, `record_prediction_resolve` credits the ledger with the expected payout immediately, but the actual USDC.e doesn't enter the wallet until on-chain CTF redemption. Until v20.2 there was no automated redemption — every winning real-mode bet would create a temporary drift (cash credited but USDC.e still locked in CTF shares) that the divergence safeguard would catch within minutes and auto-pause the daemon.

### Files added/modified
| File | Changes |
|------|---------|
| `vault/redeem.py` (new) | `redeem_prediction(conn, prediction_id, dry_run=False)` calls the right contract per market type (NegRiskAdapter for neg-risk, ConditionalTokens for binary). Idempotent (CTF balance == 0 → success/no-op). Lazy `setApprovalForAll` on first redemption. Multi-RPC fallback. `find_redeemable(conn)` returns closed real-mode wins whose shares are still on-chain. `redemption_sweep(conn)` redeems all of them and writes `redemption_adjustment` ledger entries when the actual recovered USDC differs from the credited payout. |
| `vault/agent.py` | After `record_prediction_resolve` credits a real-mode win, immediately calls `redeem_prediction` for that pred. Failures are non-fatal — the periodic sweep retries. |
| `vault/daemon.py` | Periodic `redemption_sweep` in the reconcile/orphan-sweep cadence (every `orphan_sweep_interval_cycles`). Catches anything the inline auto-redeem missed. |
| `vault/cli.py` | New `vault redeem` command. No args → list redeemable positions. `vault redeem <pred_id>` → redeem one. `vault redeem --all` → sweep everything. `--dry-run` for read-only simulation. |
| `tests/test_redeem.py` (new) | 7 tests: `find_redeemable` filtering by on-chain balance; idempotent redemption; refusal on unknown market type; refusal on non-real / non-closed; adjustment entry written when actual ≠ expected; no adjustment when they match; sweep continues past individual failures. |

### How it works end-to-end
1. Market resolves on-chain (UMA finalises the outcome).
2. Daemon's cycle-start `resolve_predictions` notices, calls `ledger.record_prediction_resolve` → status=`closed`, `payout` and `pnl` populated, ledger credit written.
3. **NEW**: For real-mode wins the agent immediately calls `redeem_prediction`. This:
   - Reads `negRisk` flag from gamma API.
   - Verifies CTF balance > 0 on-chain (else returns no-op success — already redeemed).
   - Lazily ensures `setApprovalForAll(NegRiskAdapter)` is set (one-time tx ever).
   - Calls `NegRiskAdapter.redeemPositions(conditionId, [yesAmount, noAmount])` (or `ConditionalTokens.redeemPositions(...)` for binary).
   - Waits for receipt, reads new USDC.e balance, returns the delta.
4. Periodic sweep handles auto-redeem failures from step 3 (RPC blip, gas spike, settlement delay).
5. If actual on-chain delta differs from the credited payout (rounding, partial resolution), the sweep writes a `redemption_adjustment` ledger entry to keep cash and wallet in lockstep.

### What to watch
- **First real win after v20.2 deploy**: confirm the auto-redeem fires synchronously (you should see `Auto-redeemed pred #N: +$X USDC.e (tx 0x...)` in the journalctl right after the `RESOLVED WON` line).
- **Approval tx is one-time**: first redemption ever costs an extra ~$0.01 in gas for the `setApprovalForAll`. After that, redemption is one tx (~$0.01 gas).
- **Sweep loud-fails on persistent issues**: if a redemption fails for several sweep passes, we surface it. Right now the sweep is silent on success ("0 redeemed, 0 failed" doesn't log). It logs only when work happened.

---

## v20.1 — Stealth-fill detection via on-chain CTF poll (post-25-Apr-2026 Pereira incident)

**Baseline**: daemon back online after 36-hour crash loop, $18.34 cash + 2.29 Pereira YES shares (~$2.29) = $20.63 total value, 61/61 tests green.

### What happened
On 25 April 2026, daemon attempted a $1.48 momentum bet on "Will Deportivo Pereira win on 2026-04-25?" (pred #11, YES @ 0.585). Polymarket's CLOB returned `success=true, trades=[]` — the existing logic interpreted this as "FOK rejected" and cancelled the prediction. **But 2.29 CTF shares were actually minted on-chain.** The CLOB response was lying (or settlement lagged the response by more than the existing 2-second stealth-check window).

The v20 drift safeguard caught it within 60 seconds (on-chain USDC $18.52 vs expected $20.00, drift $-1.48 = exactly the bet amount) and auto-paused. The daemon then crash-looped on the startup drift check for ~36 hours until the user investigated.

Pereira won the next day. The 2.29 YES shares are worth ~$2.29 on redemption — net win $0.81. v20's safeguards prevented loss but the gap they exposed needed closing.

### Root cause
`buy_shares` checked on-chain USDC delta immediately after `post_order` returned. Polymarket settlement is async and can lag the response by several seconds. Snapshotting too early showed zero USDC delta → fell through to "no fills" → cancelled prediction → orphan.

### Fix (scalpel — `vault/clob_client.py` `buy_shares`)
1. Snapshot CTF balance for the specific token_id BEFORE the order (alongside USDC).
2. When the response reports no fills, **poll CTF balance every 2s for 10s**. CTF mint = unambiguous on-chain proof of fill, regardless of what the CLOB API claims.
3. If CTF increased: return success with on-chain share count + actual USDC delta as cost.
4. If CTF check is RPC-blind: return new `UNVERIFIED:` error so the bet actuator marks the prediction `reconciling` (not cancelled). Orphan sweep then handles it.
5. If USDC moved without matching CTF mint: also `UNVERIFIED` — manual investigation required.

The fix avoids the "cancel and forget" path entirely whenever there's any uncertainty.

### Files modified
| File | Changes |
|------|---------|
| `vault/clob_client.py` | `buy_shares`: snapshot `ctf_before` alongside `usdc_before`. Replace immediate USDC-only stealth check with 10s CTF poll loop. New `UNVERIFIED:` error states for RPC-blind or USDC-moved-without-CTF cases. Misleading "FOK rejected" error strings updated to reflect FAK behavior. |
| `vault/actuators/bet.py` | When `fill.error` starts with `UNVERIFIED`, mark prediction `reconciling` instead of `cancelled`. Existing post-fail CTF check retained as belt-and-braces. |
| `tests/test_clob_stealth_fill.py` (new) | 4 unit tests covering: Pereira regression (CLOB lies, CTF shows shares → success); genuine no-fill (CTF + USDC unchanged → cancelled); RPC blind during CTF poll → UNVERIFIED; USDC moved without CTF mint → UNVERIFIED. |

### Deploy notes — what to watch
- Drift is currently $-0.0007 (rounding only) after retroactive ledger correction.
- Pred #11 status now `open` with on-chain truth: 2.28753 shares, $1.48 cost, $0.647 avg fill (vs $0.585 limit — partial fill at the worse price the CLOB would settle).
- Guard 4 (existing on-chain position check) blocks any duplicate Pereira bet.
- Pereira market closed → CLOB orderbook empty → daemon cannot exit pred #11 via CLOB. Manual on-chain redemption required (separate task).
- Sell path (`sell_shares`) has the same class of bug. Not patched in this release — should be mirrored in a follow-up.

### Trades since (live, real money)
| Pred | Market | Side | Size | Status | Notes |
|------|--------|------|------|--------|-------|
| #11 | Will Deportivo Pereira win on 2026-04-25? | YES | $1.48 | `open` (recovered orphan) | 2.29 shares on-chain, market resolved YES, awaiting redemption |

---

## v20 — Real-Money Safeguards (post-15-Mar-2026 incident)

**Baseline (local, pre-deploy)**: daemon paused, $2.00 balance, 1070 cycles, tests 37/37 green.

Full post-mortem of the 15 March 2026 $50 loss in [`tasks/lessons.md`](./tasks/lessons.md). Summary: paper ledger was carried forward as real money on mode flip; the divergence check silently passed when Polygon RPC was unavailable; CLOB fills weren't atomically recorded, so orders that succeeded on-chain were orphaned in the DB. This release replaces the mode transition with an explicit CLI gate, adds multi-provider RPC fallback with hard-fail semantics, and refactors bet recording into a two-phase pending→confirm/cancel flow that rolls back atomically on any failure between CLOB and the ledger.

### Files modified
| File | Changes |
|------|---------|
| `vault/db.py` | Schema v20: prediction statuses extend to pending/open/reconciling/closed/cancelled; new columns `pending_since`, `clob_attempt_id`, `fill_verified_at`; index `idx_predictions_status_mode` |
| `vault/ledger.py` | New: `record_prediction_pending`, `record_prediction_confirm` (atomic UPDATE+INSERT in `BEGIN IMMEDIATE`), `record_prediction_cancel`, `record_prediction_reconciling`, `has_pending_predictions`, `get_pending_predictions`, `go_live_reset`, `is_live`. `compute_expected_onchain` rewritten to anchor on the latest `go_live_reset` entry |
| `vault/clob_client.py` | Multi-provider RPC fallback via `rpc_fallback` config list; `_get_usdc_balance_raw()` and `get_ctf_balance()` return `None` on all-providers-failed (no more silent 0); stealth-fill paths updated to log "STEALTH CHECK BLIND" when RPC down instead of assuming |
| `vault/guardrails.py` | `check_balance_divergence()` now counts consecutive RPC failures in meta; auto-pauses after `rpc_failure_pause_threshold` (default 3). The 15-Mar bug lived here |
| `vault/daemon.py` | Startup HARD GATES in real mode: refuse if no `go_live` event in ledger; refuse if RPC can't verify on-chain; refuse if drift > tolerance. New `_orphan_sweep()` runs at startup AND whenever a pending row exists; reconciles against on-chain CTF balances |
| `vault/actuators/bet.py` | Real path completely rewritten as two-phase commit. Added real-mode position cap (`max_bet_pct_onchain`, default 10%). Added pre-trade RPC requirement (refuse if None). Added post-trade CTF verification before ledger confirm. Added go-live precondition check |
| `vault/cli.py` | New `vault verify-live` (7-gate pre-flight checker). New `vault go-live` (explicit CLI that snaps paper balance to on-chain USDC and writes `go_live_reset` ledger entry) |
| `vault/api.py` | `/api/v1/status` exposes `live`, `expected_onchain`, `pending_predictions`, `reconciling_predictions`, `rpc_failures_consecutive`. New `/api/v1/reconciliation` endpoint powers the dashboard panel |
| `dashboard/src/components/ReconciliationPanel.jsx` | New panel: internal vs on-chain balance, drift, tolerance, pending/reconciling rows. Only renders when `status.live` is true |
| `dashboard/src/App.jsx` | Mounts ReconciliationPanel above BalanceChart when live |
| `config/default.yaml` | New keys: `orphan_sweep_interval_cycles`, `pending_timeout_seconds`, `rpc_failure_pause_threshold`, `max_bet_pct_onchain`, `verify_ctf_on_confirm`, `rpc_fallback` (list). Tightened defaults: `balance_divergence_tolerance` 1.00→0.50, `dry_run_startup_cycles` 0→20 |
| `tests/` (new) | 37 tests across `conftest.py`, `test_ledger_golive.py`, `test_bet_atomicity.py`, `test_rpc_failure.py`, `test_bet_actuator_e2e.py`. Regression test `test_regression_15_march_scenario` recreates the incident conditions and asserts the new code halts correctly |
| `tasks/lessons.md` | Appended the $50 loss post-mortem: timeline, root causes (paper-phantom, RPC silent pass, non-atomic record), ten "never again" rules enforced by code |
| `tasks/go-live-real-money.md` | Rewritten as v2: pre-flight gates, test requirements, fresh-wallet hygiene, monitoring checklist, red flags with HALT criteria |

### What to watch post-deploy
- `vault verify-live` exits 0 before any real-mode restart (7 gates must all pass)
- `/api/v1/reconciliation` returns `status: "ok"` with `drift` inside tolerance
- No `status='pending'` prediction older than `pending_timeout_seconds` (300s default)
- No `status='reconciling'` predictions (means orphan sweep found a mismatch)
- `rpc_failures_consecutive` stays at 0; if it climbs, check `trading.clob.rpc_fallback`
- New regression test `test_regression_15_march_scenario` remains green on every CI run

### Go-live procedure (post-this-release)
See `tasks/go-live-real-money.md`. Summary:
1. `pytest tests/` — all green
2. `vault verify-live` — all 7 gates PASS
3. Deposit USDC to fresh wallet
4. `vault go-live` (snaps ledger to on-chain)
5. `config.yaml → simulated: false`
6. `vault start` (refuses to start without #4)
7. Monitor `/api/v1/reconciliation` for 48h before trusting

---

## v19.4 — Dashboard Simplification

**Deployed**: 2026-03-15 | **Baseline**: $51.20 balance, 599d runway

Stripped dashboard down to essentials. Removed Smart Money page (hypothesis testing for velocity signals — no data in fresh restart), CostBreakdown component, and associated API polling. Log page restructured: events (max 6) at top, full cycle log below in a fixed-height scrollable container. Nav: Home | Log.

### Files modified
| File | Changes |
|------|---------|
| `dashboard/src/App.jsx` | Removed SmartMoney import/route/nav, removed CostBreakdown from Log page, restructured LogPage layout |
| `dashboard/src/components/SmartMoneyPanel.jsx` | Deleted |
| `dashboard/src/components/CostBreakdown.jsx` | Deleted |
| `dashboard/src/components/EventTimeline.jsx` | Capped to 6 items |
| `dashboard/src/hooks/useVaultData.js` | Removed `/costs` fetch |

---

## v19.3 — USDC Deposit Auto-Detection & CLOB Order Fix

**Deployed**: 2026-03-15 | **Baseline**: $51.21 balance, on-chain USDC $0.00

Two changes: (1) Auto-detect USDC deposits to the Polymarket wallet so the internal ledger stays in sync — computes expected on-chain balance from DB state, records the difference as a deposit when it exceeds tolerance. Runs every 10 cycles in real trading mode. (2) Fixed `buy_shares()`/`sell_shares()` passing a plain dict instead of `MarketOrderArgs` dataclass to `create_market_order()`, which caused `'dict' object has no attribute 'token_id'` on every real order attempt.

### Files modified
| File | Changes |
|------|---------|
| `config/default.yaml` | Added `polygon_rpc_url` (publicnode), `reconcile_interval_cycles: 10` |
| `vault/clob_client.py` | Replaced `get_usdc_balance()` with web3 ERC20 `balanceOf` call (returns `None` on failure); fixed `buy_shares`/`sell_shares` to use `MarketOrderArgs` dataclass |
| `vault/ledger.py` | Added `compute_expected_onchain()` + `record_deposit()` |
| `vault/daemon.py` | Added `_reconcile_balance()`, wired into main loop every N cycles; handled `None` from `get_usdc_balance()` |
| `vault/cli.py` | Handled `None` from `get_usdc_balance()` in `setup-clob` |

### What to watch
- Daemon logs for "Deposit detected" after sending USDC to the proxy wallet
- Negative drift warnings (possible settlement lag or withdrawal)
- RPC reliability — publicnode.com is the current provider, may need fallback

---

## v19.2 — ARR Display Fix

**Deployed**: 2026-03-15 | **Baseline**: $51.23 balance, 848d runway

ARR stat was showing +8998% because it extrapolated a tiny balance difference over 0.1 alive days. Two fixes: if trading P&L is exactly $0, show `0%` immediately. Otherwise require ≥1 day of data before annualising.

### Files modified
| File | Changes |
|------|---------|
| `dashboard/src/components/StatusBar.jsx` | Zero-return special case, ≥1 day threshold |

---

## v19.1 — Dashboard Cleanup

**Deployed**: 2026-03-14 | **Baseline**: $51.29 balance, 7 cycles

Removed vestigial Pipeline and Memory pages from the dashboard. Pipeline showed the old Opus intelligence/sentinel/tweet pipeline (disabled since v13.5 momentum-only switch). Memory showed agent strategy memories from the `write_memory` actuator (also unused). Nav is now Home | Smart $ | Log. Also stops polling 2 dead API endpoints (`/memories`, `/calibration`) every 10s.

### Files modified
| File | Changes |
|------|---------|
| `dashboard/src/App.jsx` | Removed PipelineView import, MemoryPage component, nav items, routes |
| `dashboard/src/components/PipelineView.jsx` | Deleted |
| `dashboard/src/hooks/useVaultData.js` | Removed memories + calibration fetches |

---

## v19 — Real Polymarket CLOB Trading

**Deployed**: 2026-03-13 | **Baseline**: $120.25 balance, $152.42 total value, 137.2d runway

VAULT has been paper trading for 29 days with $125.65 realised P&L across 33,771 cycles. Signal generation, sizing, risk management, and exit logic are battle-tested. This adds a real CLOB execution layer via `py-clob-client`, controlled by the existing `trading.simulated` config flag. Everything else stays untouched — deployed with `simulated: true` (zero behaviour change).

**Changes:**
1. **`vault/clob_client.py`** (NEW) — CLOB wrapper: `buy_shares()` / `sell_shares()` (FOK orders), `resolve_token_id()`, `get_usdc_balance()`, `setup_allowances()`. Lazy singleton pattern.
2. **`vault/actuators/bet.py`** — Branches on `simulated` flag: real path resolves token ID → CLOB FOK buy → records fill data. Paper path unchanged. Fallback configurable (`skip` or `paper`).
3. **`vault/actuators/sell_prediction.py`** — Real positions sell via CLOB first, then record at fill price. Paper positions use ledger math as before.
4. **`vault/agent.py`** — `_sell_prediction_auto()` helper routes all 5 automated exits (trailing stop, stale, reversal, substandard, opportunity cost) through CLOB for real positions.
5. **`vault/db.py`** — Schema v19: `execution_mode TEXT DEFAULT 'paper'` column on predictions.
6. **`vault/ledger.py`** — `record_prediction_buy()` accepts `execution_mode` + `shares_override`. `get_open_predictions()` returns `execution_mode` + `clob_token_id`.
7. **`vault/polymarket.py`** — `_parse_clob_token_ids()` properly parses JSON string/list (same pattern as `outcomePrices`).
8. **`vault/daemon.py`** — CLOB client startup verification when `simulated: false`. Fails fast if credentials missing.
9. **`vault/prompts.py`** — Conditional: "Bets are REAL (CLOB orders)" vs "Bets are simulated".
10. **`vault/cli.py`** — `vault setup-clob` command for one-time exchange allowance approval.

### Files modified
| File | Changes |
|------|---------|
| `vault/clob_client.py` | NEW — CLOB wrapper (buy, sell, balance, allowances) |
| `vault/actuators/bet.py` | Real/paper branch after validation |
| `vault/actuators/sell_prediction.py` | CLOB sell for real positions |
| `vault/agent.py` | `_sell_prediction_auto()` for all automated exits |
| `vault/db.py` | Schema v19: `execution_mode` column |
| `vault/ledger.py` | Extended `record_prediction_buy`, `get_open_predictions` |
| `vault/polymarket.py` | `_parse_clob_token_ids()` helper |
| `vault/daemon.py` | CLOB startup verification |
| `vault/prompts.py` | Conditional simulated/real text |
| `vault/cli.py` | `vault setup-clob` command |
| `config/default.yaml` | `trading.clob` section |
| `pyproject.toml` | `py-clob-client`, `web3` dependencies |
| `.env.example` | CLOB credential placeholders |

### What to watch
- Schema migration to v19 applied cleanly on deploy (confirmed)
- With `simulated: true`, all existing behaviour unchanged
- After going live: `[REAL]` tags in bet/sell logs, fill price vs Gamma mid-price for slippage
- `execution_mode` column in predictions table: new rows show `paper` or `real`
- Balance drift between internal ledger and on-chain USDC

---

## v18 — Portfolio Drawdown Circuit-Breaker

**Deployed**: 2026-03-04 | **Baseline**: $69.97 balance, $85.07 total value, 112.7d runway

VAULT had zero portfolio-level risk management — the only protection was the death condition ($0). Historical peak was $129.30, meaning a 33% drawdown happened with no alarm. A previous $56 drawdown (50% from $111 peak) went unchecked.

**Changes:**
1. **Circuit-breaker** — tracks peak total value (cash + MTM positions) in `meta` table. If drawdown from peak >= 25%, auto-pauses via existing `meta.paused` infrastructure. Manual `vault resume` required.
2. **Check placement** — runs at top of every `run_cycle()`, before any exit sweep or entry logic. Zero API cost (uses cached odds in DB).
3. **Peak tracking** — updated at end of every cycle after objectives snapshot. Also updated inside `check_drawdown()` when new high detected.
4. **Resurrect reset** — `resurrect()` resets peak to seed amount (fresh start).
5. **API visibility** — `peak_total_value` and `drawdown_pct` exposed in `/api/v1/status`.

Peak seeded at $85.07 (current total value) — fresh start, not historical max. This avoids immediate trigger on deploy.

### Files modified
| File | Changes |
|------|---------|
| `config/default.yaml` | `drawdown_circuit_breaker` section (enabled, 25% threshold) |
| `vault/db.py` | Schema v18: seed `peak_total_value` from latest objectives snapshot |
| `vault/guardrails.py` | `check_drawdown()` function + peak reset in `resurrect()` |
| `vault/agent.py` | Circuit-breaker check at top of `run_cycle()`, peak update at bottom |
| `vault/api.py` | `peak_total_value` and `drawdown_pct` in status response |

### What to watch
- `"Circuit breaker triggered"` event — fires if total value drops to ~$63.80 (25% of $85.07)
- `drawdown_pct` in `/api/v1/status` — should climb gradually if losing, reset on new highs
- After `vault resume`, peak stays at the old value (no reset) — breaker can re-trigger

---

## v17.2.1 — Fix Shadow A/B Logging (Dead Code Bug)

**Deployed**: 2026-03-03 | **Baseline**: $68.37 balance, $80.13 total value, 138d runway

Shadow trades were never being logged (0 rows) because the position cap (`max_positions_per_market: 1`) at line 628 blocked all add signals with `continue` before the code reached the shadow evaluation at line 745. The shadow code was effectively dead.

**Fix**: Evaluate shadow variants inside the position cap check, right before skipping. Shadow trades started logging immediately after deploy — first two rows within 30 seconds.

### Files modified
| File | Changes |
|------|---------|
| `vault/agent.py` | Move `_evaluate_shadow_variants()` call into position cap block (line ~628) |

### What to watch
- `"Shadow trade logged: <variant>"` — now fires on every capped add signal
- `"(shadow evaluated)"` tag on position-cap skip log lines
- Accumulate 48h of data, then compare strict vs relaxed variant P&L

---

## v17.2 — Kill Pyramid Adds + Shadow A/B Testing

**Deployed**: 2026-03-02 | **Baseline**: $55.01 balance, $69.86 total value, 96.2d runway

Comprehensive analysis of all 2,071 momentum trades revealed pyramid adds as the sole source of negative P&L:

| | Pyramid Adds | Initial Entries | Sharp Move |
|---|---|---|---|
| Trades | 342 | 1,230 | 498 |
| Total P&L | **-$33.97** | +$27.32 | +$21.24 |
| Win Rate | 45.3% | 13.8% | 56.4% |

Peak balance was $111.20 (2026-02-20). The $56 drawdown to $55 was caused entirely by concentration risk from pyramid adds — the Tiafoe tennis match alone (7 adds, $54 deployed) lost $29.54.

**Changes:**
1. **Pyramid adds disabled** — `momentum_pyramid_enabled: false` kills all adds. Max positions per market reduced from 5 → 1.
2. **Shadow A/B testing** — when a pyramid add WOULD have fired, two shadow variants are evaluated and logged to `shadow_trades` table (schema v17). No real trades, no API cost.
   - **Strict**: max 1 add, 1.0x mult, 15% ROI gate, 30m cooldown
   - **Relaxed**: max 2 adds, 1.5x mult, 5% ROI gate, 15m cooldown
3. **Shadow resolution** — when markets resolve, shadow trades are backfilled with P&L.
4. **Visibility** — `vault shadow` CLI + `GET /api/v1/shadow/summary` + `GET /api/v1/shadow/trades` endpoints.

### Files modified
| File | Changes |
|------|---------|
| `config/default.yaml` | `momentum_pyramid_enabled: false`, `shadow_pyramid` config block, `max_positions_per_market: 1` |
| `vault/db.py` | Schema v17: `shadow_trades` table + index |
| `vault/agent.py` | Gate `is_add` on config flag, `_evaluate_shadow_variants()`, `_resolve_shadow_trades()` |
| `vault/api.py` | `GET /api/v1/shadow/summary`, `GET /api/v1/shadow/trades` |
| `vault/cli.py` | `vault shadow` command |

### What to watch
- `"Momentum skip (pyramid disabled)"` log lines — confirms adds are blocked
- `"Shadow trade logged: <variant>"` — shadow trades being recorded when signals fire
- `vault shadow` — accumulate 48-72h of data, then compare variant P&L to decide on re-enabling
- Overall P&L should improve immediately now that the -$34 capital drain is removed

---

## v17.1 — Add Cooldown + Weather Market Filter

**Deployed**: 2026-03-01 | **Baseline**: $70.37 balance, $93.32 total value, 82.4d runway

Two changes from 48h trading analysis (844 trades analysed by 4 parallel agents). Both rated 5/5 for safety — negligible risk of limiting profitable trades.

**1. Per-market add cooldown (10 minutes)**
Rapid-fire pyramid adds to the same market+side were the #1 loss vector: Tiafoe 4 adds in 3.4 min = -$29.54, XRP 4 adds in 4 min = -$16.30, cricket 4 adds in ~10 min = -$11.16. New guard queries `opened_at` of most recent open position for the same market+side; blocks if < 10 minutes. Profitable adds (e.g. Musk market) are naturally spaced and unaffected. Config: `momentum_add_cooldown_minutes: 10`.

**2. Weather/novelty market filter**
Weather markets (temperature brackets, snowfall, precipitation) consistently drain capital — Seoul: -$15.17, NYC: -$4.08 in a single 24h period. Momentum signals on temperature forecasts are meaningless. New `_is_weather_novelty_market()` function pattern-matches on question + event_title keywords. Blocks entry entirely.

### Files modified
| File | Changes |
|------|---------|
| `vault/agent.py` | Add `_is_weather_novelty_market()` function; weather filter after event_title extraction; add cooldown gate in `is_add` block |
| `config/default.yaml` | Add `momentum_add_cooldown_minutes: 10` |
| `tasks/lessons.md` | Full 48h analysis report with 5 ranked changes |

### What to watch
- `"Momentum skip (add cooldown)"` log lines — confirms rapid-fire adds are blocked
- `"Momentum skip (weather/novelty market)"` log lines — confirms weather markets filtered
- Overall P&L should improve as the two biggest capital drains are eliminated
- Watch that legitimate pyramid adds (>10 min apart) still execute normally

---

## v17 — Fix Momentum Churn Bug + Dashboard 2dp Formatting

**Deployed**: 2026-02-28 | **Baseline**: $96.19 balance, $111.69 total value, 107.6d runway

### Momentum churn bug (critical)
50.8% of all trades (1,002/1,973) were being opened and immediately sold at $0.00 P&L. Root cause: `_exit_substandard_positions()` compared momentum `entry_edge` (velocity, ~5-9.5%) against `margin_of_safety` (10%). Since velocity < 10%, momentum positions were flagged as "substandard" and closed every cycle. The guard at line 970 was supposed to skip momentum positions but only checked `entry_confidence <= 0` — momentum positions have confidence (0.75-0.8) so they weren't skipped. Fixed by adding the same `entry_reasoning` prefix check used by the other 3 exit functions.

### Dashboard formatting
Changed all dollar displays from 4dp ($0.0000) to 2dp ($0.00) across 7 dashboard files.

### Files modified
| File | Changes |
|------|---------|
| `vault/agent.py` | Add momentum reasoning guard to `_exit_substandard_positions()` |
| `dashboard/src/components/BetsPanel.jsx` | `toFixed(4)` → `toFixed(2)` |
| `dashboard/src/components/CostBreakdown.jsx` | `toFixed(4)` → `toFixed(2)` |
| `dashboard/src/components/CycleLog.jsx` | `toFixed(4)` → `toFixed(2)` |
| `dashboard/src/components/PipelineView.jsx` | `toFixed(4)` → `toFixed(2)` (×2) |
| `dashboard/src/components/PositionsPanel.jsx` | `toFixed(4)` → `toFixed(2)` |
| `dashboard/src/components/PredictionsPanel.jsx` | `toFixed(4)` → `toFixed(2)` |
| `dashboard/src/components/StatusBar.jsx` | `toFixed(4)` → `toFixed(2)` |

### What to watch
- Momentum positions should now hold until a proper exit trigger fires (reversal, trailing stop, stale, or settlement)
- Zero-pnl churn rate should drop to near zero
- Dashboard dollar values should all show 2dp

---

## v16.23.2 — Fix 18s Dashboard Load (Dead Code Removal)

**Deployed**: 2026-02-28 | **Baseline**: $101.80 balance, $111.96 total value, 114.5d runway

The dashboard showed "Connecting to VAULT API..." for ~18 seconds on every page load. Root cause: `useVaultData.js` fetched `/api/v1/smart-money/summary` (which makes external Polymarket HTTP calls) inside the shared `Promise.all`, blocking all rendering until every endpoint resolved. This fetch was dead code — `SmartMoneyPanel` already fetches its own data independently with its own 15s polling interval. Removed the redundant fetch; load time drops from ~18s to ~300ms.

### Files modified
| File | Changes |
|------|---------|
| `dashboard/src/hooks/useVaultData.js` | Remove dead `smartMoney` state + fetch from `Promise.all` |

### What to watch
- Smart Money tab should still populate via its own self-contained fetch

---

## v16.23.1 — Dashboard: ARR + British Spelling

**Deployed**: 2026-02-24 | **Baseline**: $52.73 balance, $78.00 total value, 144.8d runway

Dashboard changes:
- Replaced "API Costs" stat box with **ARR** (annualised rate of return as %). Calculated as `(total_value - seed) / seed / days_alive * 365 * 100`.
- "realized" → "realised" (British spelling).

### Files modified
| File | Changes |
|------|---------|
| `dashboard/src/components/StatusBar.jsx` | ARR box replaces API Costs; British spelling |

---

## v16.23 — Unrealised Loss Floor + Entry Reasoning Fix

**Deployed**: 2026-02-24

Post-mortem: Galorys vs ODDIK CS:GO match (Feb 23-24) lost -$7.14 across 5 YES positions despite all safeguards. The burned-market guard only fires on *realised* losses — positions were still open when new entries were added, so the system pyramided into a losing market during brief price bounces.

### Changes

1. **Unrealised loss floor guard** (`vault/agent.py`): Block any new momentum entry on a market where existing open positions are collectively underwater by more than 5% (configurable via `momentum_unrealised_loss_floor`). Inserted after the position count cap check. Would have blocked trade #535 which entered at -6.3% unrealised ROI.

2. **Entry reasoning bug fix** (`vault/actuators/bet.py`): `pipeline_edges` contains two entries per market — first from edge_calculator ("Sharp move detected:"), last from momentum executor ("Momentum add:" / "Momentum auto-follow:"). The forward loop always matched the first (wrong) entry. Fixed by iterating `reversed(pipeline_edges)` so the most-recent reasoning wins.

3. **Config** (`config/default.yaml`): Added `momentum_unrealised_loss_floor: -0.05`.

### What to watch
- False positives: legitimate entries blocked on normal 1-3% dips during active matches
- `entry_reasoning` in new trades should now show "Momentum add:" / "Momentum auto-follow:" instead of "Sharp move detected:"

### Files modified
| File | Changes |
|------|---------|
| `vault/agent.py` | ~15 lines: unrealised loss floor guard after position cap check |
| `vault/actuators/bet.py` | 1 line: `reversed(pipeline_edges)` for correct reasoning lookup |
| `config/default.yaml` | 1 param: `momentum_unrealised_loss_floor: -0.05` |

---

## v16.22.1 — British Spelling Fix

**Deployed**: 2026-02-24 | **Baseline**: $52.00 balance, $78.90 total value, 143d runway

Dashboard label "realized" → "realised" (British spelling).

### Files modified
| File | Changes |
|------|---------|
| `dashboard/src/components/StatusBar.jsx` | "realized" → "realised" |

---

## v16.22 — Side-Switch Velocity Floor

**Deployed**: 2026-02-22 | **Baseline**: $57.59 balance, $74.02 total value, 68d runway

Side-switching (closing one side, entering the opposite) is a reliable money destroyer: 23 markets with both-side trades lost -$59.98 net vs +$78.27 for single-side markets. But a blanket ban would have blocked profitable reversals like TSLA Up/Down (+$22.52) and Rio Open Lajovic (+$8.24).

Backtested velocity thresholds for side-switch trades across all 363 momentum trades:

| Threshold | Blocked | Saved | Notes |
|-----------|---------|-------|-------|
| 10% (was) | 9 | +$5 | Too loose |
| **15%** | **30** | **+$15.45** | **Sweet spot — keeps all TSLA/Rio/Dota winners** |
| 20% | 56 | +$8.82 | Blocks 4 of 5 TSLA switches |
| 25% | 75 | +$30.49 | Blocks almost all profitable switches too |

15% filters the weak flips (Goldman +6%, ChatGPT -9%, Valorant +10%, MOUZ NXT -6%) that all lost, while preserving genuine reversals that entered at 16%+ velocity.

### Side-switch velocity floor in `_analyze_momentum_opportunities()`
- New guard between `is_add` check and multi-flip guard
- If not a pyramid add AND closed opposite-side position within `momentum_flip_window_hours`, require `|v_1h| >= side_switch_min_velocity_1h` (default 15%)
- Log line: `Momentum skip (side-switch velocity floor): ... |v_1h|=X% < 15% required`

### Config
- `side_switch_min_velocity_1h: 0.15` in `velocity:` section

### Files modified
| File | Changes |
|------|---------|
| `vault/agent.py` | Side-switch velocity floor guard (~15 lines) |
| `config/default.yaml` | 1 new config param |

### What to watch
- `Momentum skip (side-switch velocity floor):` log lines — confirm weak flips blocked
- Side-switches at 15%+ should still go through (genuine reversals)
- Compare side-switch PnL over next 48h vs historical -$60 baseline

---

## v16.21 — Hard 4h Position Cap

**Deployed**: 2026-02-22 | **Baseline**: $62.64 balance, $77.71 total value, 74.6d runway

Previously `stale_max_hours` only killed positions where momentum had stalled. Positions with active momentum could be held indefinitely (MrBeast: 8h, Paradex: 11h, Goldman Sachs: 19h). Data across 363 momentum trades shows no position has ever become more profitable after 2 hours — the 4h+ bucket is pure loss:

| Duration | Trades | PnL | Avg/trade |
|----------|--------|-----|-----------|
| 0-30m | 112 | -$28.05 | -$0.25 |
| 30m-1h | 106 | +$6.58 | +$0.06 |
| **1-1.5h** | **35** | **+$27.26** | **+$0.78** |
| **1.5-2h** | **31** | **+$21.50** | **+$0.69** |
| 2-3h | 24 | +$2.62 | +$0.11 |
| 3-4h | 17 | +$2.93 | +$0.17 |
| 4-6h | 14 | -$6.15 | -$0.44 |
| 6h+ | 24 | -$8.38 | -$0.35 |

`stale_max_hours` is now a hard ceiling — sell at 4h regardless of momentum status.

### Code change in `_exit_stale_momentum()`
- `momentum_alive` check now gated by `and hours_held < stale_max_hours`
- Hard cap case checked first in exit decision, overrides all other logic
- Log line: `Hard time cap: held Xh >= 4.0h` distinguishes from stale exits

### Files modified
| File | Changes |
|------|---------|
| `vault/agent.py` | 2-line change in `_exit_stale_momentum()` — hard cap logic |

### What to watch
- `Hard time cap:` log lines — confirm positions are being killed at 4h
- No more 6h+ or 8h+ holdouts in the predictions table
- Watch for false positives: profitable positions killed at 4h that were still trending (unlikely based on data)

---

## v16.20 — Volume Guard Adjustment + Stale Timer Split + Theme Tracking

**Deployed**: 2026-02-21 | **Baseline**: $63.65 balance, 403d runway

Safeguard analysis across 264 closed momentum bets. Three changes:

1. **Volume guard $10K → $5K**: The $10K floor was net-negative (-$1.58), blocking a +$22.52 TSLA winner at $9,907 volume. $5K still catches genuinely thin markets ($96, $936 volume).

2. **Stale exit timer split**: Duration is the strongest predictor of profit/loss. Trades <1h lost -$27.46, trades 1-6h made +$39.38. Timers are now asymmetric.
   - `stale_min_hours_profitable`: 2.0 → **3.0**
   - `stale_min_hours_losing`: 1.0 → **0.5**

3. **Theme tracking in logs**: `event_title` from Polymarket's events API now logged with momentum candidates for theme performance analysis. No blocking — keyword removal already fixed the correlated-bet problem.

### Files modified
| File | Changes |
|------|---------|
| `config/default.yaml` | `momentum_min_volume` 10000→5000, stale timer split |
| `vault/agent.py` | event_title in momentum log lines |

### Also created
- `ROADMAP.md` — living development roadmap with audit recommendations

### What to watch
- `Momentum skip (low volume $X < $5,000):` — new threshold
- Markets in $5K-$10K range should now be eligible
- `theme='...'` in momentum candidate log lines — track theme P&L
- Stale exits at 30min on losers, 3h+ on winners

---

## v16.19 — Burned-Market Guard

**Deployed**: 2026-02-21 | **Baseline**: $59.90 balance, $63.61 total value, 381d runway

Feb 20's three biggest losses (-$22.99 Coleman Wong, -$13.75 TSLA $410, -$12.28 FURIA) share the same failure: the system loses money on a market, then piles more in via pyramiding and side-flipping. The oscillation dampener (v16.18) can't catch these — they only show 3-4 reversals, well below the 6-reversal trigger.

**The fix is simpler: realised losses on a market predict future losses.** If we've net-lost >$2 on a market in the last 4 hours, cap to 1 position with no pyramiding. Backtested at -$2.00 threshold: saves $51.45, loses only $5.88 (1 false positive), net benefit +$45.58.

### Burned-market computation in `_analyze_momentum_opportunities()`
- Queries `predictions` for `SUM(pnl)` where `market_id` matches and `closed_at` within lookback window
- `is_burned` flag: `net_pnl <= -$2.00` (configurable threshold + window)
- Composes with `is_oscillating` via OR — either guard can fire independently

### Dampener effects (same as oscillation dampener)
- `pyramid_mult` forced to 1.0 when burned
- `effective_max_positions` capped to 1 when burned
- `[BURNED MARKET]` tag prepended to reasoning

### Schema v15
- `idx_predictions_market_closed` compound index on `predictions(market_id, closed_at)` — benefits both burned-market query and existing multi-flip guard queries

### Config params (in `velocity:` section)
- `burned_market_lookback_hours: 4.0` — window to sum realised P&L
- `burned_market_loss_threshold: -2.00` — net P&L <= this triggers guard

### What to watch
- `Burned-market guard:` log lines — confirm fires on markets with recent losses
- `[BURNED MARKET]` in cycle reasoning — verify limited to 1 position
- Clean markets should still pyramid normally (`Momentum pyramid:` lines)
- False positives: winning markets getting capped (should be rare at -$2.00)

### Files modified
| File | Changes |
|------|---------|
| `vault/agent.py` | Burned-market guard computation + logging (~20 lines), compose into 3 existing override sites |
| `config/default.yaml` | 2 config params |
| `vault/db.py` | Schema v15, compound index migration |

---

## v16.18 — Oscillation Dampener (Mode B)

**Deployed**: 2026-02-20 | **Baseline**: $62.80 balance, 429d runway

VAULT lost $13.75 on TSLA $410 (8 trades in 3h) because the momentum system pyramided into a binary oscillating around the strike. This adds a "Mode B" dampener: markets with 6+ directional reversals (8pp swing threshold) in a 2h window get restricted to 1 position with no pyramiding. A net-move override (>15%) exempts markets genuinely trending through noise.

### Oscillation metrics in `calculate_velocity()`
- Counts directional reversals in a configurable window (default 2h, 8pp min swing)
- Returns `reversals_2h` and `net_move_2h` alongside existing velocity data
- Propagated through velocity alert builder to momentum analysis

### Dampener in `_analyze_momentum_opportunities()`
- `is_oscillating` flag: `reversals_2h >= 6 AND |net_move_2h| < 15%`
- If oscillating: `pyramid_mult` forced to 1.0, `effective_max_positions` capped to 1
- `[OSCILLATION DAMPENED]` tag prepended to reasoning for visibility in logs/dashboard
- Separate log line: `Oscillation dampener: ... — N reversals, net ±X%`

### Config params (in `velocity:` section)
- `oscillation_lookback_hours: 2.0` — reversal counting window
- `oscillation_min_swing: 0.08` — 8pp minimum to count as a reversal
- `oscillation_max_reversals: 6` — trigger threshold
- `oscillation_net_move_override: 0.15` — exempt if |net move| > 15%

### What to watch
- `Oscillation dampener:` log lines — confirm fires on appropriate markets
- `[OSCILLATION DAMPENED]` in cycle reasoning — verify limited to 1 position
- Non-oscillating markets should still pyramid normally (`Momentum pyramid:` lines)
- Backtest script at `scripts/backtest_oscillation.py` for historical validation

### Files modified
| File | Changes |
|------|---------|
| `vault/edge_calculator.py` | Oscillation metrics in `calculate_velocity()` (+18 lines), fields in velocity alert builder (+2 lines) |
| `vault/agent.py` | Oscillation flag, pyramid override, position cap override, reasoning annotation (+23 lines) |
| `config/default.yaml` | 4 oscillation config params |
| `scripts/backtest_oscillation.py` | New backtest verification script |

---

## v16.17 — Volume Guard + Keyword Cleanup

**Deployed**: 2026-02-20 | **Baseline**: $71.30 balance, $98.16 total value, 456d runway

48-hour trading analysis revealed markets with <$5K 24h volume lost -$12.34 net. Root cause: the `momentum_min_volume` ($10K) config was only enforced at the market tracking stage, not the betting stage. Keyword-matched markets (Tesla, Musk, etc.) bypassed the volume check entirely via a legacy `is_intel` flag from the disabled intel pipeline.

### Volume guard at entry stage
- Added `volume` to the mkt_row SQL query in `_analyze_momentum_opportunities()`
- New check: skip markets where total volume < `momentum_min_volume` (default $10K)
- Would have blocked all 8 bets on the TSLA $410 market ($96 volume, -$13.75 loss)

### Removed legacy keyword/intel system
- The keyword matching (Tesla, SpaceX, Elon, Musk, etc.) was dead weight since v13.5 (momentum-only mode)
- `is_intel` bypass let keyword-matched markets skip the volume check at tracking time
- `_save_cache`, keyword regex, theme building, and `intel_markets` return list all removed
- All markets now held to the same `momentum_min_volume` threshold at both tracking and entry

### Files modified
| File | Changes |
|------|---------|
| `vault/agent.py` | Added `volume` to mkt_row query; volume guard at entry stage |
| `vault/market_discovery.py` | Removed keyword/theme/intel system; uniform volume gate; removed `re` and `_save_cache` imports |

### What to Watch
- Verify no reduction in esports/tennis tracking (these have $96K-$997K volume, well above $10K threshold)
- Monitor log for `Momentum skip (low volume ...)` entries to confirm guard is firing
- Tracked market count may drop slightly (garbage markets no longer tracked)

---

## v16.15 — P1 Reliability Sweep: 8 Fixes

**Deployed**: 2026-02-20 | **Baseline**: $74.40 balance

Follow-up to v16.14 (P0 bugs). Addresses all 8 P1 items from the automated code review swarm — reliability issues, performance bottlenecks, and cost waste that degrade 24/7 operation.

### P1-7: Division by zero guard
- `_remaining_return_pct(0)` triggered `ZeroDivisionError` in `bet.py` opportunity cost gate and `_exit_opportunity_cost()`. At zero price, infinite upside is mathematically correct.
- **Fix**: Added `if our_price <= 0: return float('inf')` guard.

### P1-8: Odds-None crash fix
- Ternary precedence bug in `research_markets.py:92` and `prompts.py:65`: `odds["yes_price"] if side == "YES" else odds["no_price"] if odds else fallback` — the `if odds` guard only covered the NO branch. YES-side with `odds=None` crashed with `TypeError`.
- **Fix**: Replaced with explicit `if odds:` / `else:` blocks in both locations.

### P1-1: Database indexes (migration v14)
- 600+ unindexed scans per cycle on `odds_snapshots(market_id, ts)` for velocity calculations. Additional unindexed queries on `predictions(status)`, `api_calls(cycle_id, ts)`, `smart_money_log(market_id, outcome)`.
- **Fix**: Added 5 `CREATE INDEX IF NOT EXISTS` statements in migration v14. One-time build at startup (~5-30s on large DBs).

### P1-2: Snapshot pruning
- `odds_snapshots` table grows unbounded (~200 inserts/cycle). After weeks of operation, velocity queries degrade.
- **Fix**: New `prune_old_snapshots()` keeps all data < 48h, then 1 snapshot/market/hour for older data. Runs every 50 cycles. Config: `snapshot_prune_keep_hours`, `snapshot_prune_interval_cycles`.

### P1-6: HTTP retry logic
- All 6 `httpx.get()` calls to Polymarket Gamma API had zero retry — any transient timeout or 5xx killed the cycle.
- **Fix**: New `vault/http_utils.py` with `http_get_with_retry()`: exponential backoff (1s/2s/4s), retries on timeout, connect error, 429, 5xx. No retry on 4xx (except 429). Replaced all 5 calls in `polymarket.py` and 1 in `market_discovery.py`.

### P1-4: Single velocity fetch
- `calculate_velocity()` made 3 separate DB queries (1h, 6h, 24h windows) per market. With 200+ tracked markets, that's ~600 queries/cycle.
- **Fix**: Single `get_odds_history(hours=24)` call, partitioned into 1h/6h windows in Python. Added `_parse_snapshot_ts()` helper. Identical behavior, ~400 fewer queries/cycle.

### P1-3: Shared odds cache
- 5 exit functions each called `get_open_predictions()` + `get_current_odds()` per position — up to 10x redundant API/cache hits.
- **Fix**: Build `odds_cache` dict once before exit functions, pass `(open_preds, odds_cache)` to all 5. End-of-cycle MTM reuses cache with fallback for new positions. Stale cache is safe — existing `try/except` around `record_prediction_sell()` handles positions sold by earlier exit functions.

### P1-5: Smart Haiku routing
- Every momentum signal called Haiku ($0.002-0.004/call) even for clear signals (high liquidity, far from expiry, unambiguous category). ~95% of calls returned follow=true with 0.8 confidence.
- **Fix**: New `_should_route_to_haiku()` function auto-follows clear signals at confidence 0.75/$0 cost. Routes to Haiku only when risk triggers fire: near-resolution (<2h), mid-liquidity ($1K-$5K), or category-ambiguous (non-sports with "vs"). Rewrote Haiku prompt to give real decision authority instead of forced follow. Config: `smart_haiku_routing`, `haiku_route_near_resolution_hours`, `haiku_route_min_liquidity`, `haiku_route_max_liquidity`, `haiku_route_ambiguous_category`.

### Files modified
| File | Changes |
|------|---------|
| `vault/agent.py` | P1-7: div-by-zero guard; P1-2: prune call; P1-3: shared odds cache + exit function signatures; P1-5: smart routing + `_is_sports_market()` extraction |
| `vault/db.py` | P1-1: migration v14 with 5 indexes |
| `vault/edge_calculator.py` | P1-4: single 24h query + Python partitioning |
| `vault/polymarket.py` | P1-6: replaced 4 `httpx.get()` with retry wrapper |
| `vault/market_discovery.py` | P1-2: `prune_old_snapshots()`; P1-6: replaced 1 `httpx.get()` |
| `vault/http_utils.py` | P1-6: new module — `http_get_with_retry()` |
| `vault/prompts.py` | P1-8: odds-None fix; P1-5: Haiku prompt rewrite |
| `vault/actuators/research_markets.py` | P1-8: odds-None fix |
| `config/default.yaml` | P1-2: prune config; P1-5: smart routing config |

### What to Watch
- **Indexes**: Verify `schema_version = 14` and indexes exist after restart (`PRAGMA index_list(odds_snapshots)`)
- **Cycle time**: Expect 30-50% reduction from P1-1 + P1-4 + P1-3
- **Haiku costs**: Count `momentum_validation` API calls — should drop ~95%. Look for `Momentum auto-follow:` log lines
- **Retries**: Watch for `retry 1/3` WARNING log lines on transient Polymarket outages
- **Pruning**: After 50 cycles, `SELECT COUNT(*) FROM odds_snapshots` should stabilize
- **Crash guards**: No more `ZeroDivisionError` or `TypeError: NoneType` in logs

---

## v16.14 — P0 Bug Sweep: 6 Critical Fixes

**Deployed**: 2026-02-20 | **Baseline**: $74.40 balance

Automated code review swarm (bug-hunter, commit-reviewer, optimizer, moderator) found 22 bugs, 23 optimizations, and 12 commit-history issues across the codebase. This commit addresses all 6 P0-severity bugs — issues causing financial loss, data corruption, or crash risk.

### P0-1: Trailing stop completely broken — `peak_roi` missing from query
- `get_open_predictions()` didn't SELECT `peak_roi`, so `pred.get("peak_roi")` always returned None → defaulted to 0. The trailing stop high-water mark never persisted across cycles. Trailing stops were effectively disabled since v16.
- **Fix**: Added `peak_roi` to the SELECT column list.

### P0-2: NO-side vault probability inverted in track record
- `_build_track_record()` computed `vault_est = 1 - entry_odds - edge` for NO-side bets. Correct formula is `+ edge`. This fed corrupted calibration data to Opus, potentially degrading all future probability estimates.
- **Fix**: Changed `- edge` to `+ edge` in 3 locations (open positions, resolved, calibration).

### P0-3: Resurrect leaves phantom open positions
- After death/resurrect, old open predictions persisted and interacted with the fresh balance — phantom positions could trigger sells, resolve, or credit/debit the new balance.
- **Fix**: Close all open predictions (`resolution='abandoned'`) and positions before seeding new balance.

### P0-4: Daemon race condition — separate DB connections
- The cycle thread created a new `init_db()` connection while the main loop used a different one for `is_alive()`/`check_death()`. SQLite WAL mode meant stale reads — death events could be missed, cycles could double-fire.
- **Fix**: Share single connection with `check_same_thread=False`. Safe because the ThreadPoolExecutor has `max_workers=1` — no concurrent writes.

### P0-5: Non-atomic ledger balance updates
- Every ledger operation did read-modify-write: `balance = get_balance(); new = balance - cost; INSERT`. With separate connections (P0-4) or concurrent API requests, two operations could read the same starting balance and produce incorrect `balance_after` values.
- **Fix**: Replaced all 6 ledger write functions with atomic SQL subqueries: `(SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1) +/- ?`.

### P0-6: Migration v11-v13 crash on existing columns
- Migrations v11, v12, v13 ran bare `ALTER TABLE ADD COLUMN` without try/except guards. On fresh DB init (where SCHEMA_SQL already creates the columns), the migration would crash. Earlier migrations (v4, v6, v9) correctly used try/except.
- **Fix**: Wrapped all v11-v13 ALTER TABLEs in try/except. Also fixed `SCHEMA_VERSION = 10` → `13`.

### Files modified
| File | Change |
|------|--------|
| `vault/ledger.py` | P0-1: add `peak_roi` to SELECT; P0-5: atomic balance in all 6 write functions |
| `vault/intelligence.py` | P0-2: fix NO-side vault_est formula (3 locations) |
| `vault/guardrails.py` | P0-3: close phantom positions/predictions on resurrect |
| `vault/daemon.py` | P0-4: share connection instead of creating separate `init_db()` in thread |
| `vault/db.py` | P0-4: `check_same_thread=False`; P0-6: try/except on v11-v13 migrations; fix SCHEMA_VERSION |

### What to Watch
- Trailing stops should now fire: `grep "Trailing stop exit" logs` — first trigger expected when a profitable momentum position drops 15pp from peak
- Next Opus intelligence update: verify NO-side track record entries show corrected vault estimates
- Ledger balance integrity: `SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 5` should show monotonically consistent values
- Fresh DB init: should not crash on migration (testable with `rm vault.db && vault start`)

---

## v16.13 — Tighten Haiku Momentum Prompt

**Deployed**: 2026-02-19 | **Baseline**: $74.40 balance, 1045d runway, +$35.60 trading P&L

Haiku was rejecting strong momentum signals (ETH dip z=-6.0, BTC dip z=-5.8) by doing its own fundamental analysis — citing "resolution certainty", "contracting time window", and "tiny liquidity" ($14k-$24k is fine for Polymarket). It was ignoring the "default is follow" instruction.

**Fix**: Rewrote both system and user prompts to be much more forceful:
- System: "You MUST follow. Only reject if liquidity < $1,000 (manipulation). Do NOT analyse fundamentals."
- User: Removed "settled market" rejection reason (Python handles that). Added explicit end_date with days remaining. Added "Do NOT reject for: time to expiry, market structure, your opinion on the outcome."
- Also added raw Haiku response logging for future debugging.

Tested: Both ETH and BTC markets returned follow=true with the new prompt.

### Files modified
| File | Change |
|------|--------|
| `vault/prompts.py` | Rewrote system + user prompt to prevent Haiku from overriding momentum signals |
| `vault/agent.py` | Added raw Haiku response logging |

### What to Watch
- Haiku should now approve most signals that pass the cheap Python filters
- If bet frequency jumps too high, the Python filters (velocity, z-score, spread, liquidity) are the correct place to gate — not Haiku
- Monitor for any false follows where Haiku should have blocked (manipulation on thin markets)

---

## v16.12 — Momentum Reversal Exit + Opposite-Side Guard

**Deployed**: 2026-02-19 | **Baseline**: $74.54 balance, 1081d runway, +$35.60 trading P&L

Live-tested on Dota 2: OG vs Team Liquid. VAULT bought YES @ 0.82 on +15% velocity, game reversed, YES crashed to 0.45 then 0.02. Two bugs exposed:

**1. No reversal exit**: When velocity flipped against a momentum position, nothing cut the loss. The YES position rode from 0.82 to 0.02 (-$1.80). New `_exit_momentum_reversal()` fires immediately when v_1h flips against our side at >5% — no hold timer, no minimum loss. In the Dota 2 case, would have sold at ~0.45 (-$0.84 instead of -$1.80).

**2. No opposite-side guard**: The system bet NO @ 0.56 while still holding the YES position — betting both sides simultaneously. Added a guard before new entries: if an open position exists on the opposite side of the same market, skip. With the reversal exit, the correct flow is: sell the losing side → same cycle re-enters the new direction.

Dota 2 final P&L: +$0.69 across 5 positions ($24.97 deployed). With both fixes from the start: estimated +$1.79 on same capital.

### Files modified
| File | Change |
|------|--------|
| `vault/agent.py` | `_exit_momentum_reversal()` — velocity-reversal stop-loss, runs every cycle |
| `vault/agent.py` | Opposite-side guard before new momentum entries |

### What to Watch
- Reversal exits in logs: `Momentum reversal exit: [id] SIDE ... v_1h=X% reversed`
- Opposite-side skips: `Momentum skip (opposite side)`
- The reversal threshold (5%) is configurable via `momentum_reversal_threshold` — if too sensitive, raise it

---

## v16.11 — Fix Two Filters Blocking Legitimate Bets

**Deployed**: 2026-02-19 | **Baseline**: $73.86 balance, 1231d runway, +$34.91 trading P&L

Two filters were incorrectly blocking legitimate momentum signals:

**1. Span check too aggressive (30min → 5min)**: The Mirra Andreeva tennis match surged 46%→82% in 2 minutes during a live match — $52k liquidity, 1% spread, perfect candidate. But the 30-min span check blocked it because we'd only been tracking the market for 5 minutes. The span check was added as defense against the datetime bug (v16.9), which is now fixed. Reduced from 30min to 5min for 1h velocity, 180min to 60min for 6h.

**2. Entry odds floor removed (50% → 10%)**: The `<50%` entry filter was blocking markets like S&P Opens (YES 29%, +9.5% velocity, 71% remaining upside) and Tesla $420 (YES 39%, +6% velocity). Historical data showed the <50% bucket was actually *profitable* (+$6.46 on 93 bets), while 50-60% was the worst bucket (-$8.66). The comment claimed "0% win rate" but data showed 27%. Lowered to 10% (only block truly extreme long-shots). Haiku now decides on borderline entries.

### Files modified
| File | Change |
|------|--------|
| `vault/edge_calculator.py` | `min_span_minutes_1h`: 30 → 5, `min_span_minutes_6h`: 180 → 60 |
| `vault/agent.py` | Entry odds floor: 50% → 10% |

### What to Watch
- More velocity alerts should now reach the velocity/Haiku filters (previously hidden by span/entry blocks)
- Live sports markets with fast swings should now produce v_1h values within 5 minutes of discovery
- Monitor sub-50% entry bets: if win rate is terrible, may need a softer floor (e.g. 30%)

---

## v16.10 — Add Current Datetime to Haiku Momentum Prompt

**Deployed**: 2026-02-19 | **Baseline**: $73.87 balance, 1348d runway, +$34.91 trading P&L

Haiku rejected a live LCK esports match 30 times because it didn't know the current date. The game started at 08:00 UTC, velocity alerts fired at 09:24-09:58 UTC (match was live, DN Freecs dominating), but Haiku called Feb 19, 2026 "4+ years in the future" and rejected for "no catalyst." The prompt says "live esports moves should almost always be followed" — it just couldn't tell the game was live.

**Fix**: Pass `Current time: YYYY-MM-DD HH:MM UTC` into every momentum prompt. Compute game status from `game_start_time`: "LIVE — started 1.5h ago" / "starts in 5h" / "started 8h ago (likely finished)".

### Files modified
| File | Change |
|------|--------|
| `vault/prompts.py` | Add current datetime + computed game status to `build_momentum_prompt()` |

### What to Watch
- Next live sports/esports market with velocity: Haiku should reference correct time context
- Watch for "LIVE" in Haiku reasoning via logs
- Confirm non-sports markets (no `game_start_time`) unaffected

---

## v16.9 — Fix Broken Velocity Window (All Velocities Were Wrong)

**Deployed**: 2026-02-18 | **Baseline**: $72.02 balance, 504.7d runway, +$34.87 trading P&L

**Critical bug**: `get_odds_history()` used `datetime('now', '-1 hours')` which produces `2026-02-18 19:43:21` (space-separated), but `odds_snapshots.ts` stores ISO 8601 format `2026-02-18T19:43:21.000Z`. SQLite string comparison: `T` (ASCII 84) > ` ` (ASCII 32), so **every snapshot appeared newer than the cutoff**. The "1 hour" window was actually returning ALL snapshots — effectively all-time data. Every velocity signal since day 1 was comparing current price against the first-ever recorded price, not the price 1 hour ago.

**Fix**: Changed query to use `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ...)` to match stored format. Also added minimum span checks in `calculate_velocity()` as belt-and-suspenders defense.

**Impact**: After fix, velocity alerts dropped from 22/cycle to 3-4/cycle. Many "sharp moves" were phantom signals from stale all-time comparisons. DeepSeek V4 (the trigger for this investigation) is no longer alerting because the actual 1h price change is ~0%, not -12%.

### Files modified
| File | Change |
|------|--------|
| `vault/market_discovery.py` | `get_odds_history()`: fix `datetime()` → `strftime()` format match |
| `vault/edge_calculator.py` | `calculate_velocity()`: add `_snap_span_minutes()` minimum span check |

### What to Watch
- Velocity alert count per cycle should be much lower (real signals only)
- Existing open position (DeepSeek NO $1.85) was entered on a phantom signal — monitor for exit
- All historical win/loss rates were achieved with broken velocity — actual future performance may differ

---

## v16.8 — Z-Score Gate + Post-Filter Candidate Cap

**Deployed**: 2026-02-18 | **Baseline**: $73.88 balance, 538.1d runway, +$34.87 trading P&L

Two fixes to unblock valid non-sports momentum signals:

**Z-score gate**: The 10% non-sports velocity floor was blocking DeepSeek V4 (sustained -9.5%/1h, z=-6.7, YES 40%→24%). Rather than blanket-lowering the threshold, added a conditional override: velocity 7%+ is allowed through if z-score >= 4.0 (statistically significant moves only). Sports markets unaffected.

**Post-filter candidate cap**: `max_momentum_per_cycle: 3` was applied *before* cheap filters (entry odds, extreme, noisy market), so 3 doomed markets consumed all slots. DeepSeek (ranked 4th by z-score) never reached the velocity filter. Moved the cap downstream — now limits *accepted candidates* after all filters, not raw alerts evaluated. First cycle after deploy: z-gate fired on DeepSeek, Haiku validated at 90% confidence, BET NO $1.85 @ 78%.

### Files modified
| File | Change |
|------|--------|
| `vault/agent.py` | Z-gate override in velocity filter; move `max_per_cycle` cap after filters |
| `config/default.yaml` | `z_override_min_velocity: 0.07`, `z_override_threshold: 4.0` |

### What to Watch
- Z-gate activations: `grep "z-gate override" logs`
- More markets now evaluated per cycle — watch Haiku API cost (was $0.0017 on first cycle)
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
