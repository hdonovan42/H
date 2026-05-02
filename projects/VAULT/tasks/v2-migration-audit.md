# Polymarket v1 → v2 migration: comprehensive audit

**Audit date**: 2026-05-02
**Trigger**: Six different real-money failures since ~25 April 2026, four of which
were direct or indirect consequences of Polymarket's v1→v2 migration. Pattern
of "fix one error, hit the next" indicates we have not understood the full
migration surface.

This document catalogues every difference between v1 and v2 that we depend on,
with the affected code path, the change required, and how we'll test it.

## Source of truth

- **`Polymarket/py-clob-client`** v0.34.6 — what we currently use (v1)
- **`Polymarket/py-clob-client-v2`** v1.0.0 — official v2 client
- **`Polymarket/clob-client-v2`** (TS) — v2 reference impl
- **`Polymarket/ctf-exchange-v2`** — v2 contract repo + addresses

## Side-by-side: every behavioural difference

### 1. Settlement currency (the show-stopper)

|  | v1 | v2 |
|---|---|---|
| Token | USDC.e (`0x2791Bca1...`) | **pUSD** (`0xC011a7E12...`) |
| Decimals | 6 | 6 |
| Source | Direct from wallet | `CollateralOnramp.wrap()` mints pUSD against deposited USDC.e |
| Offramp | n/a | `CollateralOfframp` |

**Affected**: `clob_client.py` `_get_usdc_balance_raw`, `wallet_sync.py`
classification, `agent.py` runway/burn-rate calculations,
`compute_expected_onchain` in `ledger.py`, dashboard balance display.

**Change**: Treat balance as `USDC.e + pUSD` everywhere we read "cash".
Track pUSD transfers in wallet_sync. Onramp/Offramp/CollateralToken
counterparties classified internal (not deposits/withdrawals).

**Test**: contract test asserts pUSD contract exists at the pinned address
with symbol "pUSD" and decimals 6.

### 2. Exchange contracts (already migrated in v20.6, but pUSD-naive)

|  | v1 | v2 |
|---|---|---|
| Regular exchange | `0x4bFb41d5...` | `0xE111180000...` |
| Neg-risk exchange | `0xC5d563A3...` | `0xe2222d27...` |
| Settles from | USDC.e | **pUSD** |

**Affected**: `clob_v2.py` already targets v2 exchanges ✓. But our
allowance grants in `v2_allowances.py` granted USDC.e allowances —
wrong token. **Need pUSD allowances.** Already done as one-shot script
on 2026-05-02 12:30 UTC; needs to be permanent in `setup_allowances`
flow.

### 3. EIP-712 order spec (already migrated in v20.6)

| Field | v1 | v2 |
|---|---|---|
| Domain version | "1" | **"2"** |
| Order struct | 12 fields incl. nonce, taker, feeRateBps | 11 fields incl. **timestamp, metadata, builder**, NO nonce/feeRateBps/taker |

**Status**: ✓ correct in `vault/clob_v2.py` since v20.6.

### 4. Order JSON to /order endpoint

| Field | v1 | v2 |
|---|---|---|
| `order.salt` | string | **number** (parseInt) |
| `order.side` | string | string |
| `order.signatureType` | number | number |
| Body keys | `{order, owner, orderType, postOnly}` | `{order, owner, orderType, postOnly, deferExec}` |

**Status**: ✓ correct since v20.7's `parse_fill_response` rewrite + the
salt-as-int fix. Body now includes `deferExec: false`.

### 5. Allowances (where we grant + on what tokens)

| Operation | v1 | v2 |
|---|---|---|
| BUY collateral | USDC.e → v1 exchange | **pUSD → v2 exchange** |
| SELL CTF | CTF → v1 exchange (setApprovalForAll) | CTF → **v2 exchange** (setApprovalForAll) |
| Wrap/unwrap | n/a | USDC.e → CollateralOnramp (one-time) |

**Affected**: `vault/clob_client.py` `setup_allowances()` (currently
delegates to py-clob-client v1 SDK which sets v1 allowances). Needs
v2-aware version.

**Change**: write a `setup_v2_allowances()` that grants pUSD→V2_EXCHANGE,
pUSD→V2_NEG_RISK_EXCHANGE, CTF→V2_EXCHANGE, CTF→V2_NEG_RISK_EXCHANGE,
USDC.e→ONRAMP. Idempotent (skip if already MAX).

**Test**: contract test asserts our wallet has pUSD allowance to both
v2 exchanges and CTF setApprovalForAll for both.

### 6. Redemption (winning markets)

|  | v1 | v2 |
|---|---|---|
| Binary market adapter | `ConditionalTokens.redeemPositions` | `CtfCollateralAdapter` (`0xADa10...`) |
| Neg-risk adapter | `NegRiskAdapter` (`0xd91E80c...`) | `NegRiskCtfCollateralAdapter` (`0xAdA20...`) |
| Returns currency | USDC.e | **pUSD** (likely — needs verification) |

**Affected**: `vault/redeem.py`. Currently uses v1 NegRiskAdapter.
**Unknown**: does v1 adapter still work for v2 positions? Does it
return USDC.e or pUSD? Whether CTF-adapter or direct CTF redemption
is the right path.

**Change** (planned):
- Add `redemption_v2.py` mirror with v2 adapters.
- For each redemption attempt: try v2 adapter first, fall back to v1
  if the position pre-dates v2 (existing pred #11 was redeemed via v1,
  it works for v1-era positions).
- Verify return currency: query wallet pUSD AND USDC.e deltas after
  redemption.

**Test**: live integration test on the next winning market. Until
then — this is a known gap; we'll learn at first v2-resolved win.

### 7. Balance / allowance API

| Endpoint | v1 | v2 |
|---|---|---|
| `GET /balance-allowance` | reads from chain | reads from chain (server-side) |
| `GET /balance-allowance/update` | n/a | server-side allowance refresh |

**Affected**: We don't currently use these — we read on-chain directly
via `_get_usdc_balance_raw` and `get_ctf_balance`. The v2 endpoints
might cache server-side. Going direct on-chain is safer (matches what
the matching engine actually checks).

**Change**: none required. Our direct on-chain reads are authoritative.

### 8. Fee mechanics

|  | v1 | v2 |
|---|---|---|
| Fee field in order | `feeRateBps` in EIP-712 message | NOT in EIP-712 message |
| Fee source | per-token via SDK `get_fee_rate_bps` | same |
| Market-order user balance hint | n/a | `userUSDCBalance` parameter (optional) |

**Affected**: v2 `userUSDCBalance` is a hint for fee adjustment on
market BUYs. Without it, the order may be sized assuming user has
balance > amount + fee, which fails if not.

**Change**: pass `userUSDCBalance = pUSD wallet balance` when building
v2 market orders. Currently we let the SDK calculate amounts assuming
no fee adjustment. Risk: small orders fail because pUSD < amount + fee.

**Test**: place a test order at exactly wallet-balance amount, verify
it's fee-adjusted not rejected.

### 9. CTF tokens

|  | v1 | v2 |
|---|---|---|
| Contract | `0x4D97DCd9...` | **same** `0x4D97DCd9...` |
| ERC1155 | yes | yes |
| balanceOf semantics | unchanged | unchanged |

**Status**: ✓ no migration. Phase 2's on-chain share reconciliation
already handles this correctly.

### 10. Auto-resolve / position lifecycle

|  | v1 | v2 |
|---|---|---|
| Market resolution detection | gamma `closed:true, outcomePrices:[1,0]` | same |
| Where payout lands | wallet USDC.e via redemption | wallet pUSD via redemption (probably) |

**Affected**: `agent.py` resolve_predictions → vault/redeem.py.
**Unknown**: whether auto-redeem on a v2 position succeeds via v1
adapter, or requires v2 adapter.

**Change**: same as #6 — defer to first live test.

### 11. Ramp/Onramp transfers (NEW — wallet_sync impact)

In v2, our wallet sees:
- USDC.e → ONRAMP (when we wrap): outbound transfer
- ONRAMP / CollateralToken → wallet (on wrap mint): pUSD inbound
- pUSD → OFFRAMP (when we unwrap): outbound
- OFFRAMP / VAULT → wallet (on unwrap): USDC.e inbound

`wallet_sync.py` records non-internal counterparties as deposits or
withdrawals. We need to add the v2 ramp contracts to INTERNAL_ADDRESSES,
otherwise wraps look like withdrawals and unwraps look like deposits,
double-counting cash.

**Change**: add to `INTERNAL_ADDRESSES`:
- `0x93070a847efEf7F70739046A929D47a521F5B8ee` (CollateralOnramp)
- `0x2957922Eb93258b93368531d39fAcCA3B4dC5854` (CollateralOfframp)
- `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` (CollateralToken/pUSD)
- `0xC417fD8E9661c0d2120B64a04Bb3278C17E99DB1` (VAULT — pUSD reserve)
- `0xADa100874d00e3331D00F2007a9c336a65009718` (CtfCollateralAdapter)
- `0xAdA200001000ef00D07553cEE7006808F895c6F1` (NegRiskCtfCollateralAdapter)

**Test**: regression test pinned to these addresses.

### 12. Trade response shape

| Field | v1 | v2 |
|---|---|---|
| `success`, `orderID`, `trades` | yes | yes |
| `errorMsg` on failure | yes | yes |
| Trade record fields | `size`, `price`, ... | same |

**Status**: ✓ unchanged. v20.7's `parse_fill_response` works for both.

## Prioritised plan (v20.8)

| Priority | Item | Effort | Risk if skipped |
|---|---|---|---|
| P0 | wallet_sync internal addresses (#11) | small | Wrap/unwrap → false deposits/withdrawals → drift alarm |
| P0 | Balance read = USDC.e + pUSD (#1) | already done, needs deploy | Drift alarm fires |
| P0 | setup_allowances v2-aware (#5) | small | New trader hitting "allowance not enough" |
| P1 | userUSDCBalance fee hint (#8) | small | Edge-case order rejections on tight balances |
| P1 | Redemption v2 adapters (#6, #10) | medium — needs live test | Wrong token returned, drift, manual recovery |
| P2 | Auto-wrap when pUSD low (#1) | medium | Need to manually wrap when we run low on pUSD |

## What this audit deliberately leaves alone

- Decision logic (`agent.py`, `edge_calculator.py`, `pipeline.py`) — v2 doesn't
  affect strategy, only execution.
- Sim mode — never hits any v2 code.
- Gamma API — separate from CLOB, not migrated.
- Polygon RPC + on-chain primitives (CTF, etc.) — unchanged.

## Tests we're adding

1. `test_v2_addresses_pinned` — every v2 contract address pinned to known values
2. `test_pusd_is_wrapped_collateral` — symbol, decimals, onramp role
3. `test_internal_addresses_includes_v2_ramps` — wallet_sync regression
4. `test_balance_includes_pusd` — `_get_usdc_balance_raw` returns sum
5. `test_setup_v2_allowances_idempotent` — running twice doesn't re-spend gas
6. Contract tests (live):
   - pUSD contract reachable, symbol "pUSD"
   - CollateralOnramp.wrap signature unchanged
   - V2 exchange addresses match Polymarket SDK config

## Forecasted next failure modes

Things that could break us next, that this audit doesn't fully close:

- **First v2 win redemption**: until a real v2 position resolves and we redeem
  successfully, we don't know if v1 adapter works for v2 positions or which
  currency comes back. Plan: when first v2 win happens, log the redemption
  carefully and adjust based on what we observe.
- **Polymarket v3**: contract test daily check will catch this. Same migration
  pattern will recur.
- **pUSD ↔ USDC.e exchange rate drift**: today they're 1:1 by contract.
  Could change. Drift detection assumes parity.
- **Onramp pause**: If Polymarket pauses USDC.e wrapping, we can't get more
  pUSD. Mitigation: keep $2 USDC.e reserve so we can pay any fees we need
  even without a working onramp.
