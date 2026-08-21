# STOCK

Snappy US-equity lookups from the terminal — price, day move, and whether the
market is open. Built for sizing up a trade in the moment.

**Deliberately not PORTFOLIO.** That tool is an audit trail: every buy and sell
is an immutable record, auto-committed to a private vault repo. This one keeps
no state at all — no ledger, no vault, no writes. It asks a question and prints
an answer.

## Usage

```bash
stock TSLA          # price, day move, market status, intraday chart
stock TSLA --plain  # one line, no box — for scripting
```

```
╭────────────────── Tesla, Inc. (TSLA) ──────────────────╮
│                                                        │
│  $363.46   +18.33 (+5.31%)                             │
│  open 349.76   high 364.99   low 346.90   prev 345.13  │
│                                                        │
╰─────────  ● OPEN  ·  NasdaqGS  ·  14:07 EDT  ──────────╯
```

While the market is open you also get the session so far, drawn in braille —
each character packs a 2x4 dot grid, so it's a real line rather than a bar
approximation:

```
╭───────────────────────── Apple Inc. (AAPL) ──────────────────────────╮
│  $309.02   -2.28 (-0.73%)                                            │
│  open 312.05   high 312.38   low 307.01   prev 311.30                │
│                                                                      │
│     312.15                         ⣀⡀ ⡖⣆⡀⣀⡀         ⣀⣀⣀⡀             │
│            ·······················⡖⠃⠉⠓⠃·⠉⠁⠉⠓⠋⠉⡇⣀⣀⡤⠖⠒⠃··⠉⠓⣆⡀········  │
│                                ⡤⡄⡏⠁           ⠓⠃          ⠓⠦⡄        │
│                             ⡤⠏⠉⠁⠉⠁                          ⠉⠉⠓⠒⠦⣄⡀  │
│                          ⡤⠖⠋⠁                                     ⠉  │
│            ⠒⠋⠉⡇  ⡤⠤⣄⡖⠦⠤⠖⠋⠁                                           │
│     306.96    ⠉⠓⠋⠁                                                   │
│            09:30                                              14:16  │
│  · prev close                                                        │
╰───────────  ● OPEN  ·  NasdaqGS  ·  14:16 EDT · 5m bars  ────────────╯
```

The dotted rule is yesterday's close — above it you're up on the day, below
it you're down. Here AAPL opened above and crossed under mid-morning.

The chart is scaled to the session's own high/low, not to include prev close:
on a big gap day (TSLA +5%) anchoring to prev close flattens the whole line
into a squiggle. When prev close falls outside the session range it's reported
underneath as a number instead of drawn.

Border and status go red when the market is closed, and the subtitle gains
`· last close` so a stale price can't be mistaken for a live one. **The chart
only appears while the market is open** — a finished session replayed flat
isn't much use for sizing a trade — and it's skipped in the first few minutes
of trading, before there are enough bars to draw.

Lowercase works (`stock tsla`), and a trailing `?` is stripped if you type one.
Note that bare `stock tsla?` is a shell glob — quote it, or just leave it off.

## Scope

**US-listed equities, ETFs and indices only.** No crypto, no international
listings, no currency conversion — everything is USD. Keeping the scope this
narrow is what keeps it fast.

## Market status

There is no market-status field in the feed, so it's derived from two things:

1. **Session window** — 09:30–16:00 ET, Monday to Friday.
2. **Tick freshness** — the last trade must be under 5 minutes old.

Requiring both is what makes holidays work without anyone maintaining a holiday
calendar: on Thanksgiving the clock says "in session" but the tape hasn't moved
since yesterday, so it correctly reports CLOSED.

## Speed

One HTTP call, ~0.2s end to end including Python startup — the chart is free.
The intraday series and the quote metadata arrive in the same response, so
asking for `interval=5m` instead of `interval=1d` costs about 20ms and saves
a second request.

Only Yahoo (via the Cloudflare Worker) is used. Finnhub was measured at ~906ms
median against Yahoo's ~94ms and supplies nothing that isn't already in the
Yahoo response — including the day's open, which comes from the chart
indicators rather than the metadata.

The worker occasionally answers with an empty or non-JSON body, so requests
retry up to 3 times on *parse* failure, not just on HTTP status.

## Files

| File | Purpose |
|------|---------|
| `STOCK.py` | The whole tool (~200 lines). |
| `requirements.txt` | `click`, `rich`, `requests` — same three as PORTFOLIO. |

## Install

```bash
pip install -r projects/stock/requirements.txt
printf '#!/usr/bin/env bash\nexec python3 %s/STOCK.py "$@"\n' "$PWD/projects/stock" > ~/.local/bin/stock
chmod +x ~/.local/bin/stock
```
