# Portfolio CLI: `riskfree` → `sp500`

`riskfree` compounded US T-bills (+20% since Nov 2021: right for cash, not the
yardstick wanted). Replaced with the S&P 500 total return, renamed so the
command says what it measures, and the source caption dropped from the output.

## Tasks

- [x] Confirm the old figure: +20.2% from 2021-11 is correct for T-bills; the
      French download was also failing (site returns HTML), hence "62d estimated"
- [x] Pick the series: Yahoo `^SP500TR` (dividends reinvested) from 1988-01-04
      via the worker; matches S&P's published calendar-year returns
- [x] Cache: full history in one call (9,774 days, 250 KB) in
      `~/.cache/portfolio/sp500tr.json`; top up only days after the last stored;
      today's live bar used, never stored
- [x] `sp500` command: same dates/--amount/--vs as before; dates in the title are
      the trading days used; "Ahead of / Behind the S&P 500 … points/yr"; no caption
- [x] Remove T-bill code (French/FRED fetch, rf_growth, --refresh) and the old
      `~/.cache/portfolio/riskfree.json`
- [x] Docs: README section rewritten (what it answers, reading the output, what's
      measured, dates, data + cache, checks); --help and group docstring
- [x] Public/private diagram (Mermaid) in this README and the vault's README;
      vault README gains the `sp500` command
- [x] `.gitignore` guard: no ledger can be committed under `projects/portfolio/`
      (a test ledger from 2026-05-11, before the vault, remains in H's history)
- [x] Commit + push (H and the vault)

## Review

Verified:
- 2021-11 → today: **+80.4%** (+12.61%/yr); price-only `^GSPC` would say +68.0%
- Calendar years match S&P published TR: 2020 +18.40, 2021 +28.71, 2022 −18.11,
  2023 +26.29, 2024 +25.02; 2010–2019 +13.56%/yr
- HTTP calls: first run 1 (full download); END=today 1 (live price); past window 0
- Cache short by 10 days → one top-up call, result identical to a fresh download
- Damaged cache → re-downloads; worker unreachable → uses stored closes with a warning
- Errors: START before 1988, future dates, END ≤ START, both dates on one trading
  day, unknown `--vs` ticker
- `--vs AAPL` from 2015: +25.14%/yr, ahead by 11.31 points/yr; `--vs 30%` from
  2021-11: behind by 7.19 points/yr
