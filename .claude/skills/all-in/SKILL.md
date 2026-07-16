---
name: all-in
description: Load full All-In project context for working on the stock tracking website.
argument-hint: [task description]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, WebFetch, WebSearch
---

# All-In — Stock Tracker

Load context and begin working on the All-In stock tracker. If arguments are provided, carry out that task. Otherwise, ask what to work on.

## Project Overview

Real-time stock price tracker dashboard focused on TSLA. Mission: make hjd.ai the go-to destination for checking TSLA price instead of Yahoo Finance or Perplexity. Four apps: main tracker, TSLA news aggregator, earnings dashboard, and compare page (TSLA divestment analysis + accounts).

- **Repo path**: `projects/all-in/`
- **Live**: https://hjd.ai/projects/all-in/
- **Worker**: https://dry-poetry-72b5.donovanh59.workers.dev
- **Deploy**: Push to `main` → GitHub Actions → GitHub Pages (frontend); `npm run deploy:worker` (backend)

## Architecture

### Frontend (React + Vite)

Four entry points:
- `index.html` → Stock tracker (StockTracker.jsx + StockChart.jsx)
- `tsla.html` → TSLA news aggregator (TeslaNews.jsx)
- `earnings.html` → Earnings dashboard (EarningsControlCentre.jsx)
- `compare.html` → Compare page (CompareTracker.jsx + CompareChart.jsx + AccountPanel.jsx): up to 5 symbols vs TSLA (swap-rate TSLA÷X / ratio / indexed, 3M/6M/1Y, default 1Y), what-if portfolio table, magic-link accounts with up to 20 named portfolios

Base path: `/projects/all-in/`

### Backend (Cloudflare Worker)

Single file: `worker.js` (~2100 lines). Proxies all API calls, handles news collection (cron every 30 min), earnings data racing, caching, magic-link auth + per-account portfolio storage.

4 KV namespaces: `NEWS_STORE`, `EARNINGS_STORE`, `SEEN_URLS`, `AUTH_STORE` (login/session token hashes, `account:<email>` portfolio blobs, sign-in rate-limit counters)

### Data Sources

| Source | Data | Notes |
|--------|------|-------|
| Yahoo Finance | OHLCV, quotes, 52-week range, pre/post prices | Free, no auth |
| Finnhub | Real-time price (WebSocket), earnings, forward P/E | Free tier: 1 concurrent WS |
| Alpaca | Market clock/status, extended hours bars | Authoritative for holidays |
| FMP | Shares outstanding, analyst estimates, earnings surprises | |
| SEC EDGAR | 10-K/10-Q/8-K filings, XBRL financial data | |
| Google News | RSS feed scraping for TSLA headlines | |
| Frankfurter | USD → GBP exchange rate | |

## Key Files

| File | Purpose |
|------|---------|
| `src/components/StockTracker.jsx` | Main component (~600 lines): state, WebSocket, data fetching, spreadsheet |
| `src/components/StockChart.jsx` | SVG chart (~400 lines): line/candle, zoom, hover tooltip |
| `src/components/TeslaNews.jsx` | News feed UI with source filters |
| `src/components/EarningsControlCentre.jsx` | Earnings dashboard with live conference call |
| `src/components/CompareTracker.jsx` | Compare page: multi-symbol state, ratio maths, portfolio table |
| `src/components/CompareChart.jsx` | Multi-series SVG chart (swap/ratio/indexed modes) |
| `src/components/AccountPanel.jsx` | Magic-link sign-in + saved-portfolio manager |
| `src/utils/accountApi.js` | Session storage + auth/portfolio API wrappers |
| `src/components/earnings/` | Earnings subcomponents (data, price, chart, video, transcript, twitter, news) |
| `src/hooks/useEarningsData.js` | Earnings data fetching hook (multi-source racing) |
| `src/utils/api.js` | API calls to worker |
| `src/utils/marketState.js` | Market hours detection (Alpaca clock authoritative) |
| `src/utils/cache.js` | LocalStorage cache (1-hour TTL) |
| `src/utils/config.js` | Constants: WORKER_URL, CACHE_DURATION, EARNINGS_DATE |
| `worker.js` | Cloudflare Worker: all endpoints, earnings racing, news collection |
| `wrangler.toml` | Worker config (KV bindings, cron, compatibility) |
| `scripts/mag7-tracker.js` | Monthly Mag 7 snapshot exporter → MagSeven.xlsx |

## Market State Logic

```
PRE_MARKET:  4:00 AM - 9:30 AM EST
OPEN:        9:30 AM - 4:00 PM EST
POST_MARKET: 4:00 PM - 8:00 PM EST
CLOSED:      overnight, weekends, holidays
```

- Alpaca clock is authoritative (handles holidays)
- Local time calculation is fallback only
- "Today" spreadsheet row shown only when regular trading occurred (OPEN or POST_MARKET)
- Do NOT rely on Yahoo's `tradingDay` field during pre-market

## Real-Time Updates

- Finnhub WebSocket is primary (instant price updates)
- Exponential backoff on failure (500ms → 30s cap), max 3 retries → 60s wait
- Falls back to 5-second REST polling during market hours
- Health check every 15 seconds to detect stale connections
- `wsAvailable` state tracks WebSocket status

## Worker Routes

**Price/Quote**: `/yahoo/:symbol`, `/yahoo-earnings/:symbol` (next earnings date via cookie+crumb quoteSummary), `/finnhub/ws-url`, `/finnhub/quote/:symbol`, `/finnhub/metric/:symbol`
**News**: `/news/TSLA`, `/news/update`, `/news/reset`, `/news/cnbc/:ticker`, `/tweets/:username`
**Earnings**: `/earnings/unified/:symbol?mode=race|merge`, `/earnings/stored/:symbol/:quarter?`, `/earnings/manual/:symbol/:quarter`
**FMP**: `/fmp/shares-float/:symbol`, `/fmp/analyst-estimates/:symbol`, `/fmp/earnings-surprises/:symbol`, `/fmp/sp500-weight`
**Market**: `/clock`, `/trades/:symbol`, `/bars/:symbol`
**Misc**: `/exchange-rate`, `/transcripts/:ticker/:quarter`
**Accounts**: `POST /auth/request` (magic link via Resend from signin@send.hjd.ai — domain verified 2026-07-16; rate-limited 5/hour per IP+email, counters in AUTH_STORE `rl:*`), `POST /auth/verify` (single-use token → 90-day session), `GET /portfolios`, `POST /portfolios/save|rename|delete` (Bearer session; unique names, max 20). Local dev: `npx wrangler dev --port 8787 --var DEV_ECHO_LINK:1` echoes the link instead of emailing; pair with `VITE_WORKER_URL=http://localhost:8787 npm run dev`.

## Earnings Racing

- `useEarningsData()` hook calls `/earnings/unified/:symbol?mode=race`
- Worker races 5-6 sources in parallel, returns fastest winner
- Sources: Finnhub Calendar, Finnhub Historical, SEC EDGAR XBRL, FMP Estimates, FMP Surprises, AlphaVantage
- Confidence levels: `single` → `partial` (>0.02 discrepancy) → `validated` (sources agree)
- Polling: 5s on earnings night, 30s normal, throttled when tab hidden
- Update `EARNINGS_DATE` in `src/utils/config.js` before each earnings call

## Development

```bash
cd projects/all-in
npm install
npm run dev          # Vite dev server (localhost:5173)
npm run build        # Production build → dist/
npm run preview      # Preview production build
```

No local backend server needed — dev frontend calls the deployed Cloudflare Worker directly.

## Deployment

- **Frontend**: Push to `main` branch → GitHub Actions auto-deploys to GitHub Pages
- **Worker**: `npm run deploy:worker` (uses wrangler)
- Worker name: `dry-poetry-72b5`

## Environment Variables (worker secrets)

```
ALPACA_KEY_ID_ENV, ALPACA_SECRET_KEY_ENV
FINNHUB_API_KEY_ENV
FMP_API_KEY_ENV
ALPHA_VANTAGE_KEY_ENV
RESEND_API_KEY_ENV      # magic-link email; sender constant SIGNIN_FROM in worker.js
```

## Rules

- **Clean up failed attempts immediately** — no dead code, unused imports, or superfluous additions from failed attempts
- **Alpaca clock is authoritative** for market state — never use local time alone
- **British spelling** throughout user-facing text
- **Update config.js EARNINGS_DATE** before each earnings call
- **Test WebSocket & polling behaviour** during market hours before committing
- All market times in EST (America/New_York), use dayjs with timezone plugins
- Mobile breakpoint at 700px
- Font: IBM Plex Mono

## Task

$ARGUMENTS
