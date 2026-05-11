# PORTFOLIO.py

Stock portfolio tracker. CLI lives in H, data lives in a separate private GitHub repo.

## Use

```bash
portfolio buy TSLA 10        # direct
portfolio sell AAPL 5
portfolio                    # interactive — prompts for action/ticker/qty
portfolio value              # live prices + total
portfolio history            # transaction log
```

(`portfolio` is the alias in `~/.bashrc`; otherwise `python3 PORTFOLIO.py ...`.)

Every BUY/SELL shows the **before** and **after** portfolio as a `rich` table.

## Architecture

- **Code** lives in H at `projects/portfolio/`. Clone H to any machine to get the CLI.
- **Data** lives at `~/.portfolio-vault/portfolio.json` — a clone of the private repo `github.com/hdonovan42/PORTFOLIO`. **Nothing about your trades touches the H monorepo.**

## One-time bootstrap

On every machine where you want to record trades:

```bash
cd projects/portfolio
bash setup-vault.sh           # clones the data repo to ~/.portfolio-vault/
pip install --user -r requirements.txt
```

Requires the GitHub auth on your machine to have access to the private `PORTFOLIO` repo.

## Redundancy (three failure-independent layers)

1. **Working file** — `~/.portfolio-vault/portfolio.json`, atomic write on every mutation.
2. **Local git history** — every BUY/SELL is a commit in `~/.portfolio-vault/`.
3. **GitHub remote** — pushed to `github.com/hdonovan42/PORTFOLIO` after each commit.

A push failure prints a yellow warning and leaves the local commit intact; the next successful run catches up.

## Recovery

- File clobbered: `git -C ~/.portfolio-vault checkout portfolio.json`
- Local vault deleted: `bash setup-vault.sh` re-clones from GitHub
- GitHub repo lost: any local `~/.portfolio-vault/` has the full history; re-create the remote and `git push`

## Data

Single source of truth: an append-only transaction log + a derived positions cache.

```json
{
  "version": 1,
  "transactions": [
    {"id": 1, "ts": "2026-05-11T14:30:00Z", "action": "BUY", "ticker": "TSLA", "quantity": 10}
  ],
  "positions": {"TSLA": 10}
}
```

Positions are recomputed from transactions on every load — transactions are authoritative.

## Price source

Reuses the deployed `all-in` Cloudflare Worker (`/finnhub/quote/:symbol` with Yahoo fallback). No API keys.
