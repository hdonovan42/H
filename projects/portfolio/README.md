# PORTFOLIO.py

Stock portfolio tracker. CLI lives in H, data lives in a separate private GitHub repo.

## Commands

| Command | What it does |
|---|---|
| `portfolio buy <TICKER> <QTY>` | Record a buy. Shows the **before** and **after** portfolio as a table. |
| `portfolio sell <TICKER> <QTY>` | Record a sell. Rejected (red error, no state change) if `QTY` exceeds the held position. |
| `portfolio` | Interactive mode — prompts you for action (`buy`/`sell`), ticker, and quantity. Same before/after flow as the direct commands. |
| `portfolio value` | Show the current portfolio with live prices and a USD `TOTAL` row. Fetches prices from Finnhub via the `all-in` Cloudflare Worker (Yahoo fallback). |
| `portfolio history` | Show every BUY/SELL ever recorded as a numbered table with timestamps. |

Every BUY/SELL is automatically saved, committed to `~/.portfolio-vault/`, and pushed to GitHub (see [Redundancy](#redundancy-three-failure-independent-layers)).

If the `portfolio` alias isn't set up on this machine, substitute `python3 /path/to/H/projects/portfolio/PORTFOLIO.py` for `portfolio` in any of the above.

## Architecture

- **Code** lives in H at `projects/portfolio/`. Clone H to any machine to get the CLI.
- **Data** lives at `~/.portfolio-vault/portfolio.json` — a clone of the private repo `github.com/hdonovan42/PORTFOLIO`. **Nothing about your trades touches the H monorepo.**

## Bootstrapping a new machine

The CLI is portable across machines via `git clone H`. The data store, Python deps, and shell alias are per-machine and need a one-time setup.

### 1. Run the script directly to see what's needed

After cloning H, your first run can be done by full path (no alias yet):

```bash
python3 ~/path/to/H/projects/portfolio/PORTFOLIO.py
```

(Substitute the actual path to your H clone — e.g. `$HOME/hjd.ai/H/projects/portfolio/PORTFOLIO.py` if you mirror this machine's layout.)

If anything is missing, the script prints a bootstrap panel telling you what to do. Specifically:

### 2. Install Python deps

```bash
pip install -r /path/to/H/projects/portfolio/requirements.txt
```

On PEP 668 systems (Debian/Ubuntu 23.04+), add `--user --break-system-packages` or use a virtualenv.

### 3. Clone the data vault

```bash
bash /path/to/H/projects/portfolio/setup-vault.sh
```

Requires the GitHub auth on the new machine to have read+write access to the private `hdonovan42/PORTFOLIO` repo. The script clones it to `~/.portfolio-vault/` and seeds an empty portfolio if the repo is fresh.

### 4. Add the `portfolio` alias (optional but recommended)

The alias is shell config, not part of H, so it does **not** carry over. Add it explicitly:

```bash
echo 'alias portfolio="python3 $HOME/hjd.ai/H/projects/portfolio/PORTFOLIO.py"' >> ~/.bashrc
source ~/.bashrc
```

(Replace `$HOME/hjd.ai/H` with wherever you cloned H on the new machine.) From then on, every new terminal picks it up automatically — `source ~/.bashrc` is only needed in the shell where you ran the `echo` command.

After steps 2–4 you can run `portfolio value` from anywhere.

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

## Starting fresh

If you want to wipe all trades and reset to an empty portfolio (typical after testing):

```bash
cd ~/.portfolio-vault && rm -rf .git && git init -b main && \
  git remote add origin https://github.com/hdonovan42/PORTFOLIO.git && \
  printf '{\n  "version": 1,\n  "transactions": [],\n  "positions": {}\n}\n' > portfolio.json && \
  git add portfolio.json && git commit -m "init: empty portfolio" && \
  git push --force -u origin main
```

This wipes the local git history, force-pushes a single empty-portfolio commit to the remote, and discards every prior trade.
