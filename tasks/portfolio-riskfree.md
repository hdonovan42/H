# Portfolio CLI: `riskfree` command

Approved design: rolling US T-bill return from any date since July 1926.
Ken French monthly RF (1926-07 → ~2-month lag) stitched with FRED DTB3 daily
yields for the tail. Cache in `~/.cache/portfolio/` (7-day TTL, stale fallback).
Phase 2 included: `--vs TICKER` (Yahoo adjusted closes via the All-In worker,
which forwards period1/period2 — verified) and `--vs N%` for a hand-supplied return.

## Tasks

- [x] Verify worker /yahoo route forwards period1/period2 + adjclose (yes; meta.firstTradeDate available)
- [x] Data layer: fetch/parse French zip + FRED DTB3 CSV, JSON cache with TTL + stale fallback
- [x] Compounding: day-walk growth factor (whole-month fast path; monthly RF ^(1/dim) for partials; DTB3 tail with carry-forward)
- [x] `riskfree` command: flexible dates (YYYY / YYYY-MM / YYYY-MM-DD), --amount, --vs (% or ticker), --refresh
- [x] Rich output: growth, total %, annualised %/yr, excess pp/yr; captions for sources + estimated tail days
- [x] Errors: pre-1926-07 floor, future START/END, end ≤ start, ticker history too short (hint first trade date)
- [x] Verify: all benchmarks passed (see Review)
- [x] Docs: README usage + new section; CLI group docstring updated
- [x] Commit + push; update portfolio-cli memory

## Review

Shipped in `PORTFOLIO.py` (~190 lines added, no new dependencies — stdlib
`zipfile`/`bisect`/`calendar` only). No worker changes needed: the existing
`/yahoo/:symbol` route already forwards `period1`/`period2` and returns adjclose.

Verification against known figures:
- $1 from 1926-07-01 → **$25.43** (+3.29%/yr) — matches Ibbotson/SBBI ~$25
- 1980-1990: **+8.89%/yr** — matches the known ~8.9% decade average
- 2000-2020: **+1.63%/yr** — matches Damodaran's low-rate era figure
- Tail-only window (2026-06 → today, past French coverage): +3.75%/yr from DTB3 ✓
- `--vs AAPL` from 2015: +25.20%/yr, excess +23.20 pp/yr ✓
- `--vs ^GSPC` from 1950 (negative epoch): +8.30%/yr, excess +4.28 pp/yr — textbook price-only equity premium ✓
- Error paths all verified incl. "AAPL has no data at 1970-01-01 — its history starts 1980-12-12"
- Cached run: 110 ms

Deliberate choices: cache in `~/.cache/portfolio/` (NOT the vault — refetchable
public data would pollute the auto-pushed git history); `riskfree` doesn't
require the vault at all (pure calculation); days past the last published DTB3
yield are carried forward and flagged in the caption.
