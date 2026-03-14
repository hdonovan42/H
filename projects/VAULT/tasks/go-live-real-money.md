# VAULT: Go Live — Real Money Checklist

Status: IN PROGRESS
Date started: 2026-03-13

---

## Step 1: Code Deployment [DONE]

- [x] CLOB execution layer implemented (v19)
- [x] Deployed to VPS with `simulated: true`
- [x] Schema v19 migration applied (execution_mode column)
- [x] Daemon healthy: $120.25 balance, 152.42 total value, 137.2d runway
- [x] Commit: `a29d204`

## Step 2: Fund Polymarket Account [BLOCKED — exchange KYC]

### 2a. Exchange setup
- [ ] Coinbase account created
- [ ] KYC verification complete
- [ ] Deposit ~£42 GBP via faster payments (free)
- [ ] Buy $50 USDC

### 2b. Transfer to Polymarket
- [ ] Open Helsinki proxy (see below)
- [ ] Sign in to Polymarket
- [ ] Go to Deposit → copy your Polymarket wallet address
- [ ] On Coinbase: Withdraw USDC → paste address → select **Polygon network** (NOT Ethereum)
- [ ] Wait for confirmation (~2 min on Polygon)
- [ ] Verify USDC balance appears in Polymarket

### Helsinki proxy (for Polymarket access)
```bash
# WSL terminal — open tunnel
ssh -D 0.0.0.0:1080 -N -p 8443 hq@89.167.4.126

# PowerShell — launch Edge through proxy
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --proxy-server="socks5://127.0.0.1:1080"
```
If Windows can't find the SSH key:
```powershell
Copy-Item "\\wsl$\Ubuntu\home\hdonovan\.ssh\id_ed25519" ~\.ssh\id_ed25519
```

## Step 3: Extract Wallet Credentials [WAITING on Step 2]

You need two values from Polymarket:

### Private key
- Polymarket uses an embedded wallet (Magic/Privy) — you may not be able to directly export the private key
- **Option A**: If Polymarket shows "Export wallet" in settings, use that
- **Option B**: If you connected an external wallet (MetaMask, Rabby), export from there: Settings → Security → Reveal private key
- **Option C**: Create a fresh wallet in MetaMask, export its private key, then connect that wallet to Polymarket and deposit USDC to it

The safest approach is **Option C** — a dedicated wallet just for VAULT:
1. Install MetaMask browser extension (in the Helsinki proxy Edge session)
2. Create new wallet → write down seed phrase
3. Switch network to Polygon
4. Export private key: Account details → Show private key
5. Connect this wallet to Polymarket
6. Deposit USDC into this wallet (from Coinbase or via Polymarket bridge)

### Funder address
- This is simply the wallet's public address (0x...)
- Visible in MetaMask or Polymarket profile

## Step 4: Add Credentials to VPS [WAITING on Step 3]

```bash
ssh hq@89.167.4.126

# Add to .env (replace with actual values)
echo 'POLYMARKET_PRIVATE_KEY=0x_your_private_key_here' >> /home/hq/vault/.env
echo 'POLYMARKET_FUNDER_ADDRESS=0x_your_wallet_address_here' >> /home/hq/vault/.env

# Verify
cat /home/hq/vault/.env
```

## Step 5: Approve Exchange Allowances [WAITING on Step 4]

One-time setup — approves USDC + conditional token spending for Polymarket's exchange contracts.

```bash
ssh hq@89.167.4.126 "cd /home/hq/vault && .venv/bin/vault setup-clob"
```

Expected output:
- CLOB client connected
- On-chain USDC balance: $50.00
- Allowances approved successfully

## Step 6: Go Live [WAITING on Step 5]

```bash
ssh hq@89.167.4.126

# Edit config
nano /home/hq/vault/config.yaml

# Change:
#   trading:
#     simulated: false

# Restart daemon
cd /home/hq/vault && .venv/bin/vault stop && .venv/bin/vault start
```

Startup should log: `CLOB client ready. On-chain USDC: $50.00`

## Step 7: Monitor First 24h

```bash
# Watch logs for [REAL] tags
ssh hq@89.167.4.126 "cd /home/hq/vault && .venv/bin/vault logs -n 10"

# Check predictions table for execution_mode
ssh hq@89.167.4.126 "cd /home/hq/vault && sqlite3 vault.db \"SELECT id, question, execution_mode, clob_token_id FROM predictions ORDER BY id DESC LIMIT 10\""

# Compare internal balance vs on-chain
ssh hq@89.167.4.126 "cd /home/hq/vault && .venv/bin/vault status"
```

### What to watch
- `[REAL]` tags in bet/sell log lines
- `execution_mode = 'real'` on new predictions
- Fill price vs Gamma API mid-price (slippage gauge)
- Balance drift between internal ledger and on-chain USDC
- Any `CLOB order failed` warnings — check fallback behaviour

### Emergency rollback
If anything goes wrong:
```bash
ssh hq@89.167.4.126
# Edit config.yaml → simulated: true
cd /home/hq/vault && .venv/bin/vault stop && .venv/bin/vault start
```
Paper and real positions coexist — existing real positions will continue to be tracked, new ones will be paper.

---

## Config Reference

VPS `.env` needs:
```
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER_ADDRESS=0x...
```

VPS `config.yaml` for go-live:
```yaml
trading:
  simulated: false
  clob:
    slippage_pct: 0.02         # 2% max slippage
    fallback_on_failure: skip  # "skip" = reject trade, "paper" = fall back to paper
```
