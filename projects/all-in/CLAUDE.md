# All-In Stock Tracker

Real-time Tesla stock price tracker. Mission: when checking TSLA price, go to hjd.ai instead of Yahoo or Perplexity.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Dev server (localhost:5173)
npm run build        # Production build to dist/
npm run preview      # Preview production build
npm run test:transitions  # Simulated week: a page left open must equal a cold load at every transition
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
| Finnhub | Real-time price (WebSocket), forward P/E | Free tier: 1 concurrent connection |

## Key Files

| File | Purpose |
|------|---------|
| `src/components/StockTracker.jsx` | Main component: state, data fetching, spreadsheet logic |
| `src/components/StockChart.jsx` | Chart visualization |
| `src/utils/api.js` | API calls to Yahoo, Alpaca, FMP, Finnhub |
| `src/utils/marketState.js` | Market hours detection using Alpaca clock |
| `src/utils/cache.js` | LocalStorage caching (1-hour TTL) |
| `worker/` | Cloudflare Worker proxy for API calls |
| `tests/transitions.mjs` | Transition test: mocked worker + fake clock, one page lives through a week |

## Market State Logic

The `MarketState` enum defines four states:
- `PRE_MARKET` (4:00 AM - 9:30 AM EST)
- `OPEN` (9:30 AM - 4:00 PM EST)
- `POST_MARKET` (4:00 PM - 8:00 PM EST)
- `CLOSED` (overnight, weekends, holidays)

**Alpaca clock is the authoritative source** for market status. Local time calculation is fallback only.

### Session model — why nothing needs "updating" on a transition

Every session-shaped number derives from ONE date, the session the page is showing, never
from a quote snapshot. Yahoo's quote meta describes whichever session *Yahoo* considers
current — all pre-market that is yesterday's, so its `previousClose` is two sessions back —
which is what used to make values stick across the open.

- `hasTradedToday` / `getSessionDate` (`src/utils/marketState.js`): today once it has traded
  (clock open, witnessed open, or a daily bar dated today after 09:30), else the latest
  earlier daily bar. A bar Yahoo dates today before the open is ignored.
- Spreadsheet rows = daily bars up to the session; today's row is rebuilt from its own 1-min
  bars + the resolved live price. **Previous close = the row before the session row**, so the
  1D dotted line, the change figure and the spreadsheet cannot disagree.
- Day range = the session row. 1D chart = the session's bars only. 6M–5Y end on the session row.
- ONE loading effect keyed on `(ticker, sessionKey)`, sessionKey = `EST date | market state`:
  every transition — including midnight and a laptop waking hours later — reloads every dataset.

| Time | Session shown | Today row |
|------|---------------|-----------|
| Pre-market / overnight before 09:30 | previous session | No |
| Open, post-market, evening after a session | today | Yes |
| Weekend / holiday | last session | No |

After the bell Alpaca's clock cannot tell a holiday from a normal close (next_open is tomorrow
either way), so `getMarketState(clock, { tradedToday })` takes `tradedToday`; without it a
weekday evening is assumed to be post-market.

Close settle: lock only once Yahoo's `regularMarketTime` reaches the session close (the official
print) and holds for K reads — never on stability alone. A lock expires when post-market ends.

Do NOT take `tradingDay`, `open`, `previousClose` or day high/low from Yahoo's quote meta — derive
them from bars. **`npm run test:transitions` must pass after any change to this logic.**

## Real-Time Price Updates

During market hours, uses Finnhub WebSocket for instant price updates. If WebSocket fails (e.g., connection limit reached), falls back to REST polling every 5 seconds:

```
WebSocket connects → instant updates
WebSocket fails → polling starts (5s interval)
WebSocket reconnects → polling stops
```

The `wsAvailable` state tracks WebSocket status. Health check runs every 15s to attempt reconnection. See `StockTracker.jsx` lines 275-500 for WebSocket logic and lines 559-597 for fallback polling.

## Technical Conventions

- All market times are **EST** (America/New_York timezone)
- Uses `dayjs` with timezone plugins for date handling
- Mobile breakpoint at 700px

## Code Quality Rules

**Clean up failed attempts immediately.** If an approach doesn't work (e.g., an API field doesn't exist, a method fails), revert ALL changes from that attempt before trying an alternative. Never leave dead code, unused imports, or superfluous additions from failed attempts in the codebase. The user should not need to prompt for cleanup.

## Known Issues
- Could localStorage fill up with many stock searches? (needs try/catch)

## Current Priorities

(none currently)
