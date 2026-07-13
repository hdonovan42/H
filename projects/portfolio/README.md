# PORTFOLIO

A single-file command-line stock portfolio tracker. Records buy/sell transactions,
derives your current holdings, and shows live valuations with `rich`-formatted tables.

Your trade data is **not** stored in this repo. It lives in a separate private git
repo cloned to `~/.portfolio-vault/`, and every mutation is auto-committed and pushed —
so your ledger stays in sync (and backed up) across every machine you use.

## How it works

- **Transactions are the source of truth.** Each `buy`/`sell` appends an immutable
  record (action, ticker, quantity, price) to `portfolio.json`. Current positions
  are *recomputed* from the full transaction list on every read — never stored as
  authoritative state.
- **The data vault is a separate private repo.** `PORTFOLIO.py` reads and writes
  `~/.portfolio-vault/portfolio.json`; the directory is a clone of
  `github.com/hdonovan42/PORTFOLIO`. After each change the CLI runs
  `git add` → `commit` → `push` automatically (failures are warned about, not fatal —
  the local write is always kept).
- **Writes are atomic.** State is written to a `.json.tmp` file and then
  `os.replace`d into place, so an interrupted run can't corrupt your ledger.
- **Live prices** come from a Cloudflare Worker proxy
  (`dry-poetry-72b5.donovanh59.workers.dev`): Finnhub first, Yahoo as fallback.
  Tickers whose price can't be fetched are shown as `—` and excluded from the
  total and the weights.

## Setup (first run on a new machine)

The CLI refuses to run until the data vault exists locally. Bootstrapping is two steps:

1. **Confirm git/`gh` auth** on this machine can read the private
   `hdonovan42/PORTFOLIO` repo.

2. **Clone the data vault** — this is what `setup-vault.sh` does:

   ```bash
   bash projects/portfolio/setup-vault.sh
   ```

   The script:
   - Clones the private repo into `~/.portfolio-vault/`
     (override the URL with `PORTFOLIO_REPO_URL` if needed).
   - If the repo has no `portfolio.json` yet, seeds an empty one
     (`{"version": 1, "transactions": [], "positions": {}}`) and commits + pushes it.
   - Is **idempotent** — if `~/.portfolio-vault/` already exists it just reports
     "✓ Vault already present" and exits cleanly, so it's safe to re-run.

3. **Install dependencies:**

   ```bash
   pip install -r projects/portfolio/requirements.txt
   ```

   On PEP 668 systems (Debian/Ubuntu 23.04+) add `--user --break-system-packages`,
   or use a virtualenv.

4. **(Optional) Add a global alias** so you can run it from anywhere:

   ```bash
   echo 'alias portfolio="python3 '"$PWD"'/projects/portfolio/PORTFOLIO.py"' >> ~/.bashrc
   source ~/.bashrc
   ```

## Usage

```bash
portfolio buy AAPL 10 @ 401.00   # buy 10 AAPL at $401.00
portfolio sell AAPL 4 @ 415.50   # sell 4 (refuses if you hold fewer than 4)
portfolio buy AAPL 10            # no price → asks: current price or enter your own
portfolio value                  # holdings with live prices, weights + total (heaviest first)
portfolio history                # full transaction ledger (with recorded prices)
portfolio                        # no subcommand → interactive prompt
```

Every `buy`/`sell` records a **price**. Supply it with `@` (e.g. `buy AAPL 10 @ 401.00`).
Leave it off and the CLI follows up with a choice — use the current market price
(shown as a preview) or type your own:

```
portfolio buy AAPL 10
→ No price given. [1] at current price ($401.23)  [2] enter price
```

Tickers are upper-cased automatically. Quantities must be integers ≥ 1 and prices
must be > 0. `buy` and `sell` print a before/after positions table and the committed
message. Run `portfolio --help` for the full command reference.

## Files

| File | Purpose |
|------|---------|
| `PORTFOLIO.py` | The CLI (click commands + rich rendering). |
| `setup-vault.sh` | One-time per-machine bootstrap — clones the private data vault. |
| `requirements.txt` | `click`, `rich`, `requests`. |

## Data layout

`~/.portfolio-vault/portfolio.json`:

```json
{
  "version": 1,
  "transactions": [
    { "id": 1, "ts": "2026-06-02T09:30:00Z", "action": "BUY", "ticker": "AAPL", "quantity": 10, "price": 401.00 }
  ],
  "positions": {}
}
```

`positions` on disk is incidental — it's always recomputed from `transactions` at load time.
