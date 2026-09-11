# All-In — Changelog

## 2026-09-11 — Session model: market transitions no longer need a refresh

Opening the tracker pre-market left the 1D dotted line (previous close) on the close from two
sessions back after 09:30. It was one of a family of values that went stale whenever the market
changed state without a reload; all of them are fixed, and a test now guards the whole class.

### Found and fixed (one root cause)
- 1D dotted line stuck on the wrong close after the open (reported)
- Today's row **open** was the 04:00 pre-market print on every load (Yahoo omits `regularMarketOpen`,
  and the quote series includes pre-market); high/low were yesterday's range unioned with today's
  ticks after a pre-market load; volume froze at load. Day Range stat stale the same way
- 1D chart overlaid yesterday's session with today's first tick at the open
- 6M–5Y charts froze at page load and never showed today's move
- POST_MARKET was never entered with the Alpaca clock (every weekday evening was classed a
  holiday), so the post-market price never updated
- Close settle locked a preliminary print for the whole evening if it held for ~45 s
- A laptop waking after the close showed "settling…" for up to 15 minutes

### How
- **One session date** (`getSessionDate` / `hasTradedToday`, `src/utils/marketState.js`). Previous
  close = the row before the session's row; today's row is rebuilt from its own 1-min bars + the
  resolved live price; Day Range reads that row; the 1D chart shows only the session's bars; 6M–5Y
  end on the same row. The quote now supplies only live price, extended-hours price, 52-week range
  and fundamentals — Yahoo's meta describes *its* current session, which pre-market is yesterday's.
- **One loading effect** keyed on (ticker, EST date | market state) reloads every dataset on every
  transition, midnight and wake-from-sleep included. Replaces the first-clock-load refetch, the
  close-edge refetch and the per-state intraday effect; five copy-pasted bar fetchers became one
  `fetchBars`; `chartCache` removed.
- Holiday vs normal close after the bell (indistinguishable from Alpaca's clock) resolved from
  whether today traded.
- Settle locks only once Yahoo's `regularMarketTime` reaches the session close (plus 3 equal reads);
  a lock expires when post-market ends; the close edge settles only for today's close inside the
  window, otherwise lands where a cold load would.

### Files
`src/components/StockTracker.jsx`, `src/components/StockChart.jsx`, `src/utils/marketState.js`,
`src/utils/api.js`, `tests/transitions.mjs` (new), `package.json` (`playwright-core` dev dep,
`npm run test:transitions`), `CLAUDE.md` (session model section).

### Verified
- `npm run test:transitions` — mocked worker with Yahoo's quirks (two-back pre-market
  `previousClose`, 90 s lagging open, premature pre-market bar, preliminary close print), fake
  clock, UK timezone. One page lives Thu 03:30 → Wed 13:00: pre-market, open, settle, post,
  overnight, weekend, Labor Day, a ~20 h sleep. **18/18 checkpoints equal a cold load and the
  model**, two consecutive runs. The same test against the previous code: **83 failures**,
  including the reported one.
- Live smoke, production build against the real worker (11 Sep, 13:51 ET): dotted line $363.56 =
  10 Sep close; today's open $364.14 (was $364.50); 1D line one session; no page errors.
- Not yet observed: `regularMarketTime` at a real 16:00 close. If Yahoo never stamps 16:00:00, the
  15-minute backstop still locks the correct value — the amber light just lasts longer.

## 2026-07-22 — Compare page polish

- Portfolio table gains a **Chg** column next to price: most recent day change, absolute then percent, green/red like the main-page spreadsheet (computed from the live quote, unaffected by manual price overrides)
- **Tickers are clickable** (chips + portfolio rows) → opens the main tracker for that stock; the tracker now supports `index.html?symbol=XYZ` deep links and keeps the param in sync when switching tickers

## 2026-07-16 — Compare page, magic-link accounts, named portfolios

New fourth app: **compare.html** — TSLA divestment analysis (framed from an all-in TSLA position).

### Compare page
- Up to 5 symbols: TSLA pinned + SPCX/GOOGL/PLTR defaults + one free slot (add via validated ticker input, remove via chips). SPCX = SpaceX, listed 12 Jun 2026 — short history clips cleanly in all views.
- Three chart modes on a multi-series SVG (3M / 6M / 1Y, default 1Y):
  - **Swap rate** (default): TSLA ÷ X — how many shares of X one TSLA share buys; divest when it peaks
  - **Ratio**: X ÷ TSLA
  - **Indexed**: all series incl. TSLA rebased to 100 at their first bar in range
- Portfolio table: editable shares per symbol, live price (60 s poll) with manual override (2 dp normalised on Enter/blur, amber tint, ↺ reset), value + weight % + totals. Working copy persists in localStorage `compare_portfolio_v1` (safe from the tracker page's `clearCaches`).
- Main tracker header links to the page ("compare").

### Accounts (magic-link) + saved portfolios
- Email → single-use sign-in link (15 min TTL) → 90-day session (Bearer token; KV stores only SHA-256 hashes of tokens).
- Up to **20 named portfolios per account** — unique names, save/overwrite, load, rename, delete.
- Worker endpoints: `POST /auth/request`, `POST /auth/verify`, `GET /portfolios`, `POST /portfolios/save|rename|delete`. Sign-in requests rate-limited 5/hour per IP and per email.
- Email via **Resend** HTTP API; until `RESEND_API_KEY_ENV` is set the endpoint returns 503 and the UI says sign-in isn't configured yet.

### Internals
- New KV namespace `AUTH_STORE` (id `3d1b0242411a4fa58b814d5daae78163`).
- `parseYahooBars`/`backfillLatestClose` moved from StockTracker into `src/utils/api.js` (shared with the compare page); behaviour unchanged.
- `WORKER_URL` now honours `VITE_WORKER_URL` (local testing against `wrangler dev`).
- Local dev recipe for the auth flow: `npx wrangler dev --port 8787 --var DEV_ECHO_LINK:1` (echoes the magic link in the response; local KV) + `VITE_WORKER_URL=http://localhost:8787 npm run dev`.

### Deployment
- Frontend: push to main → GitHub Pages. Worker: `npm run deploy:worker` (done at ship time).
- Baseline at ship (15–16 Jul 2026): TSLA ~$390, SPCX ~$132, GOOGL ~$355, PLTR ~$134; swap rates ≈ 2.97 / 1.10 / 2.91.
- **Resend configured same day**: send.hjd.ai verified (DKIM/SPF/MX, eu-west-1) via the Resend Cloudflare wizard; send-only API key stored as `RESEND_API_KEY_ENV`. Production sign-in emails confirmed delivering.
- **What to watch**: the 5/hour sign-in rate limit (per IP and per email) when testing repeatedly — counters live in AUTH_STORE under `rl:*` and can be deleted with `wrangler kv key delete` if needed.

### Same-day follow-ups
- Account panel moved below the portfolio table
- Saved-portfolio rows show total value + per-ticker weights (fetches prices for symbols outside the working set)
- YTD and 5Y chart ranges (bars now fetched at 5y daily; YTD slices by calendar date)
- **Drag-and-drop reorder** of saved portfolios; the top one is the **default** that auto-loads when the page opens (`order` array in the account blob + `POST /portfolios/reorder`; renames keep their position)
- Ticker limit raised to **8** (TSLA + 7); three colours added to the series palette

## Earlier milestones (summary)

- **2026-07-13** — Per-symbol earnings date in the stats panel (was a hardcoded TSLA constant)
- **2026-06-27** — Backfill null daily closes from Yahoo meta (days no longer vanish from the spreadsheet)
- **2026-06-19** — Close-settle pipeline: market-close price harmonised across price box, spreadsheet and status light
- **2026-06-04** — Live trailing point on the 1D chart
- **2026-05 / 2026-04** — 1D chart correctness (single trading day filter), tab title = ticker, SVG label coordinate fixes
- **2026-03 and earlier** — Core tracker: Finnhub WebSocket with REST-polling fallback, Alpaca market clock, OHLC spreadsheet with infinite history scroll, USD/GBP value column; TSLA news aggregator (tsla.html); earnings dashboard (earnings.html) with multi-source racing
