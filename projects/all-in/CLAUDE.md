# All-In Stock Tracker

Real-time Tesla stock price tracker. Mission: when checking TSLA price, go to hjd.ai instead of Yahoo or Perplexity.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Dev server (localhost:5173)
npm run build        # Production build to dist/
npm run preview      # Preview production build
```

## Architecture

- **Frontend**: React + Vite, multi-entry build (`index.html` main app, `tsla.html` news app)
- **Backend**: Cloudflare Worker at `https://dry-poetry-72b5.donovanh59.workers.dev`
- **Deployment**: GitHub Actions to GitHub Pages (auto-deploys on push to main)

## Data Sources

| Source | Data | Notes |
|--------|------|-------|
| Yahoo Finance | OHLCV, quotes, 52-week range, pre/post prices | Use bars not price for OOH |
| Alpaca | Market clock/status, extended hours bars | Authoritative for market state |
| FMP | Shares outstanding | |
| Finnhub | Real-time price (WebSocket), forward P/E | WebSocket currently supports one user |

## Key Files

| File | Purpose |
|------|---------|
| `src/components/StockTracker.jsx` | Main component: state, data fetching, spreadsheet logic |
| `src/components/StockChart.jsx` | Chart visualization |
| `src/utils/api.js` | API calls to Yahoo, Alpaca, FMP, Finnhub |
| `src/utils/marketState.js` | Market hours detection using Alpaca clock |
| `src/utils/cache.js` | LocalStorage caching (1-hour TTL) |
| `worker/` | Cloudflare Worker proxy for API calls |

## Market State Logic

The `MarketState` enum defines four states:
- `PRE_MARKET` (4:00 AM - 9:30 AM EST)
- `OPEN` (9:30 AM - 4:00 PM EST)
- `POST_MARKET` (4:00 PM - 8:00 PM EST)
- `CLOSED` (overnight, weekends, holidays)

**Alpaca clock is the authoritative source** for market status. Local time calculation is fallback only.

### Spreadsheet Row Logic

A "today" row in the spreadsheet should only appear when regular trading has occurred:

```javascript
// StockTracker.jsx ~line 559
const regularHoursToday = currentMarketState.isRegularHours ||
  currentMarketState.state === MarketState.POST_MARKET;
const shouldProcessTodayRow = regularHoursToday;
```

| Market State | Today Row Shown | Why |
|--------------|-----------------|-----|
| PRE_MARKET | No | Regular trading hasn't started |
| OPEN | Yes | Live trading happening |
| POST_MARKET | Yes | Regular trading completed |
| CLOSED | No | Weekend/holiday/overnight |

Do NOT rely on Yahoo's `tradingDay` field - it returns today's date during pre-market due to intraday timestamps.

## Technical Conventions

- All market times are **EST** (America/New_York timezone)
- Uses `dayjs` with timezone plugins for date handling
- Mobile breakpoint at 700px
- WebSocket has reconnection logic for real-time updates

## Known Issues

- Avg volume calculation differs from Yahoo's methodology
- 1D graph sometimes draws incorrectly on market open
- Could localStorage fill up with many stock searches? (needs try/catch)

## Current Priorities

1. WebSocket: currently only supports one user - needs fix for multi-user
