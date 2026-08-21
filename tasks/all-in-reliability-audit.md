# All-In Reliability Audit — 2 July 2026

Full-stack audit of the All-In stock tracker for data reliability, uptime, and update speed.
Three parallel deep-dives: Cloudflare Worker, frontend real-time data layer, earnings/news pipelines.
~45 findings consolidated below, prioritised. File:line refs verified by the auditing agents.

**Verdict:** structurally sound (good error isolation, abort handling, partial-failure tolerance) but
not bulletproof. Three systemic gaps: (1) the UI lies about data freshness, (2) there is no
last-known-good fallback anywhere, so any upstream blip becomes a user-visible failure, and
(3) nothing detects or alerts on degradation. Plus several outright bugs that hit hardest on
earnings night — the exact moment the dashboard exists for.

---

## P0 — Correctness bugs (the dashboard shows wrong things)

### P0.1 Post-market misclassified as CLOSED on every normal weekday
`src/utils/marketState.js:72` — `isHoliday = !weekend && !isOpen && nextOpen !== today`. After the
4pm bell, Alpaca's `next_open` is tomorrow, so every normal evening is flagged as a holiday →
state forced CLOSED, never POST_MARKET. Consequences:
- Extended-hours polling (`StockTracker.jsx:828`, gated on `isExtendedHours`) never runs post-close
  → the post-market price is frozen. TSLA earnings are aftermarket (`config.js:5`), so the most
  important move of the quarter doesn't update.
- `determineInitialPhase` (`pricePhase.js:28`) can't return SETTLED/SETTLING on evening cold-loads.
- The POST_MARKET today-row branch (`StockTracker.jsx:958`) is effectively dead code.
**Fix:** only treat "not open + next_open ≠ today" as holiday when *before* the open; between
16:00–20:00 ET on a weekday, classify POST_MARKET. Better: expose Alpaca's calendar via the worker.

### P0.2 EARNINGS_DATE timezone parse — earnings night never triggers from the UK
`EarningsControlCentre.jsx:33` — `dayjs(CONFIG.earningsDate).tz(EST)` parses `'2026-04-22'` as
*local* midnight then converts, shifting the date to the 21st for any viewer at/east of UTC.
`isEarningsNight` is then false on the real night → no 5s polling, no LIVE banner. You're in the UK,
so this bug affects you every quarter.
**Fix:** `dayjs.tz(CONFIG.earningsDate, EST)` (parse *in* EST).
Related (H): `EARNINGS_DATE` is a manual constant — forget to update it and live mode silently
never arms. Derive next earnings date from the Finnhub calendar (worker already fetches it) with
the constant as override only.

### P0.3 Earnings validation system is dead code on the live path
`useEarningsData.js:96` waits for `result.pendingSources?.length > 0 && result.allResults > 1`,
but the worker race response (`worker.js:1540-1547`) never emits those fields → the merge upgrade
never fires. The worker *does* background-merge into KV (`worker.js:1509-1538`), but subsequent
reads only serve stored data when `stored.manual === true` (`worker.js:1306`) — so cross-validated
data is written and never surfaced. On earnings night the UI shows single-source numbers with no
DiscrepancyWarning and no `validated ✓` all night. The confidence UI plumbing exists and is ~90%
wired — it just never receives live data.
**Fix:** serve the background-merged KV record on subsequent polls (freshness check instead of the
`manual` gate), and/or race once for fast paint then poll merge mode.

### P0.4 Race mode can display last quarter's numbers as live
`worker.js:1497-1547` — race takes the first source returning *any* data, no quarter check (merge
mode has one at `worker.js:1207`). Finnhub `/stock/earnings` often still holds the prior quarter
right after a release and returns no error, so it can win → dashboard shows Q-1 actuals as if live.
Also: a single-source winner means EPS-only or revenue-only sources leave the other metric "N/A"
all night (`EarningsData.jsx:110-129`).
**Fix:** reject race winners whose quarter isn't in the expected window; prefer sources with both
metrics (finnhub-calendar, EDGAR) on earnings night.

### P0.5 "Last updated" always shows the current time
`StockTracker.jsx:1200` renders `dayjs().format(...)` — wall-clock at render, and the component
re-renders every second. A frozen price shows a fresh timestamp indefinitely.
**Fix:** track a real `lastUpdatedAt` set only when a price actually lands (WS onmessage :675,
fallback :882, fetchStockData :181); render that.

---

## P1 — Resilience (survive upstream blips; stop self-inflicted outages)

### P1.1 No last-known-good fallback anywhere for core price data
Worker: quote/clock/bars/chart have no KV persistence — cache miss + upstream down = error to the
client (`worker.js` §2). Frontend: `clearCaches(ticker)` runs on every mount
(`StockTracker.jsx:506`) *before* `getCachedData` (:152), so the 1-hour localStorage cache never
serves a paint; on total outage `resolvePrice` returns 0 and the box renders **$0.00**
(`pricePhase.js:51`, `StockTracker.jsx:1090`).
**Fix:** worker writes last-known-good quote/clock to KV via `ctx.waitUntil` on every success and
serves it tagged `stale: true` on upstream failure. Frontend stops clearing cache on mount, serves
cached bars for instant first paint, and keeps a last-good quote to render clearly labelled stale.

### P1.2 No connection/staleness indicator
`StockTracker.jsx:1097` — the status dot only encodes market open/closed, never connection health.
Dead WS + failing fallback is visually identical to live.
**Fix:** live / delayed / offline badge driven by WS state + last-update age; stale banner when
last successful update > ~20s during regular hours or price is 0.

### P1.3 Free-tier quota exhaustion (self-inflicted outage)
`worker.js:701-721, 803-866, 1414-1436` — `/fmp/*` routes and AlphaVantage merge calls are
uncached or edge-cached only. FMP = 250 calls/day, AV = 25/day; `caches.default` is per-colo and
best-effort so "24h TTL" does not mean one call/day. `/fmp/sp500-weight` does 1+N calls per cache
miss. A dozen earnings-day visitors exhaust AV in minutes, FMP within the hour → errors for
everyone for the rest of the day.
**Fix:** KV-backed response caching (cross-colo, durable) with sane TTLs; KV daily budget counter
per provider that serves last-known-good once near the cap; backoff on 429.

### P1.4 No timeouts on most upstream fetches
Only `proxyFetch` (worker.js:315) has an AbortController. All finnhub/fmp/av/edgar/yahoo/news
fetches, and all in-component fetches in StockTracker (bars :154, chart :287, intraday :356,
weekly :392, monthly :421, more-history :253, sort :1040 — also missing `res.ok` checks), can hang
indefinitely. In merge mode one hung source stalls the entire earnings response
(`Promise.all`, worker.js:1560). `fetchMoreHistory`/`handleSort` wedge `isFetchingMore=true`
forever on a hang.
**Fix:** shared `fetchWithTimeout` (5–8s) on every worker upstream call; per-source timeout in
merge; route StockTracker's raw fetches through the existing `api.js` fetchWithTimeout + ok checks.

### P1.5 Zero observability — degradation is invisible until a user notices
No `/health`, no cron heartbeat, no alerting. If the news cron dies, `news:TSLA` serves stale KV
for 7 days then expires to empty ("No news yet"); the frontend shows `Last refreshed: {new Date()}`
(`TeslaNews.jsx:45`) — client fetch time, not collection time — so staleness is invisible
(worker returns `lastCollected` at :498; frontend ignores it).
**Fix:** `GET /health` returning KV reachability, `lastCollected` age, provider/key status, cron
heartbeat age; write a heartbeat key each cron run; point an external uptime monitor at it (VPS
cron + email/alert would do); frontend shows "collected Xm ago" and warns > 60min.

### P1.6 Market-open edge: overnight tab keeps yesterday's baseline
`StockTracker.jsx:551-560` refetches on the open→close edge but there's no close→open equivalent;
`quote.pc/o` and day high/low stay a day stale, so every change/% is computed against yesterday's
close until manual reload.
**Fix:** mirror the close-edge effect: on `isOpen false→true`, `clearCaches` + `fetchStockData`.

### P1.7 WebSocket resilience gaps
- Zombie window (`StockTracker.jsx:594, 781, 872`): silently-dead socket keeps `wsAvailable=true`
  → fallback suppressed up to ~75s with no update mechanism at all. Proactively flip to polling
  when `now - lastMessageTime` exceeds a smaller bound.
- Orphaned reconnect timer (`:748-751` vs `:769-772`): health-check reconnect never clears a
  pending `reconnectTimeout` → later double-connect tears down a healthy socket (bad on Finnhub's
  1-connection free tier); health check also resets `reconnectAttempts`, defeating backoff.
  Clear the timer at `connectWebSocket` entry; unify reconnect paths.
- No `visibilitychange` handler — post-wake recovery waits on the 15s health check. Add
  visible→ force health check + one immediate fetch.

### P1.8 Earnings-night fetch starvation + hot-key KV writes
- `useEarningsData.js:47-50`: every 5s poll aborts the in-flight request; if unified takes >5s
  (races slow upstreams uncached), data never lands — UI sits loading with AbortError swallowed.
  Skip the tick when a request is in flight; abort only on ticker change.
- `worker.js:1528-1533, 1589-1596, 1671-1678`: every merge/race-background writes the same
  `earnings:SYM:latest/history` keys — KV allows 1 write/sec/key; concurrent earnings-night users
  → dropped writes, lost-update race on history. Debounce/single-writer.

---

## P2 — Hardening and polish

| # | Finding | Where | Fix |
|---|---------|-------|-----|
| 1 | `/fmp/earnings-surprises` returns HTTP 200 on upstream errors (no status forwarded, no ok check; also uses FMP's deprecated /api/v3) | worker.js:713-721 | route through proxyFetch |
| 2 | `/yahoo-quote` uses deprecated Yahoo v6 quote endpoint — likely 401s | worker.js:1747 | migrate to v8; verify frontend dependence |
| 3 | Earnings "BEAT by $0.00" when estimate is null (`null >= 0` → true) | EarningsData.jsx:116 | gate on `surprise != null` |
| 4 | Revenue discrepancies never recorded → conflicting revenue can show `validated ✓` | worker.js:1249-1263 | mirror EPS discrepancy check |
| 5 | Selecting a historical quarter is clobbered by the next poll within 5–30s | useEarningsData.js:149,193 | pause live overwrite while browsing + "back to live" |
| 6 | "Refresh News" sends no auth → 401 swallowed, appears to work | TeslaNews.jsx:53-64, worker.js:506 | check response.ok, decide auth contract |
| 7 | "Add tweet" POSTs `/news/tweet` — route doesn't exist (404) | TeslaNews.jsx:80 | implement or remove form |
| 8 | Earnings CNBC panel: 15s polling of an uncached live Google RSS scrape, silent failure | earnings/NewsFeed.jsx:9-26, worker.js:427 | KV-cache 5min, error state, back off |
| 9 | `earningsNight` flips up to 5min late (driven by 5-min clock fetch) | EarningsControlCentre.jsx:81,129 | drive off the 30s ticking clock |
| 10 | Full-page spinner gates ready earnings data behind the price fetch | EarningsControlCentre.jsx:208 | per-panel loading |
| 11 | Price box requires historical bars to render; quote serialized behind bars fetch | StockTracker.jsx:177 | decouple; set quote from priceData alone |
| 12 | EDGAR companyfacts is 20–50MB parsed in-worker for big tickers | worker.js:914,1349 | use companyconcept; KV-cache result |
| 13 | News-store KV "lock" is racy (eventual consistency) and discards items when contended | worker.js:234-260 | single-writer via cron; don't drop on contention |
| 14 | Corrupt earnings KV blob → 500 instead of live-fetch fallthrough | worker.js:1305 | wrap, fall through |
| 15 | Unguarded `res.json()` in /alphavantage, /exchange-rate, sp500 sub-parses | worker.js:822,1828,740-758 | guard, stale-fallback |
| 16 | sp500-weight caches partial results 24h; hardcoded divisor drifts | worker.js:764-792 | don't cache partials |
| 17 | Exchange-rate fallback only set on throw, not on non-OK → £ sign on $ numbers | StockTracker.jsx:913-921 | set fallback on !ok |
| 18 | `/clock`, `/fmp/shares-float`, `/news/cnbc` have no Cache-Control | worker.js:467 etc | add short caches |
| 19 | proxyFetch stamps Content-Type: application/json on HTML error bodies | worker.js:323 | forward upstream type |
| 20 | CIK map duplicated; GOOG missing from the second copy | worker.js:873,1322 | single constant |
| 21 | Symbol path segment uninterpolated-validated | worker.js:628 | `^[A-Z.\-]{1,6}$` guard |
| 22 | "Invalid Date"/"NaN ago" on missing publishedAt; index React keys; ÷0 in change% | TeslaNews.jsx:5,168; PriceDisplay.jsx:26 | guards, stable keys |
| 23 | setState-after-unmount: uncancelled 3s timeout, unguarded quarter fetches | useEarningsData.js:97,113-165 | clear timers, mounted guard |
| 24 | Clock-fetch failure loses holiday awareness (local fallback shows open on holidays) | marketState.js:51-63, api.js:30 | acceptable; note only |
| 25 | SEEN_URLS write pressure near free-tier KV budget on busy days | worker.js cron | watch; bounded by TTL |

---

## Already good (don't touch)
- Worker: outer try/catch always returns a Response; proxyFetch pattern (timeout+status forwarding);
  news collectors isolated with partial-failure tolerance; cron errors caught; SEEN_URLS 30-day TTL;
  race correctly rejects fast *errors* (only data wins); Bearer auth on mutation routes; WS proxy
  keeps Finnhub key server-side; EDGAR YTD-contamination filter; discrepancy/confidence engine.
- Frontend: api.js fetchWithTimeout; abort-per-ticker with signal guards (no cross-ticker bleed);
  WS resubscribes on reconnect; health check does eventually catch zombies; settle state machine +
  resolvePrice single source of truth; ErrorBoundary; cache.js fully guarded (corrupt JSON, quota).
- Earnings hook: recursive setTimeout (no drift/pile-up); tab-hidden throttling + refocus refresh;
  no-store on unified; confidence UI primitives all exist (just not fed — see P0.3).

## Suggested sequencing
1. **P0.1–P0.5** — small, surgical fixes; each makes the dashboard stop being *wrong*.
2. **P1.1–P1.5** — the bulletproofing layer: last-known-good + staleness honesty + quota budget +
   timeouts + /health with an external monitor.
3. **P1.6–P1.8**, then P2 quick wins opportunistically (1, 3, 6, 7, 17 are minutes each).

Verification notes: P0.1/P0.2 are testable locally by mocking the Alpaca clock and setting a fake
EARNINGS_DATE; P0.3/P0.4 need a worker deploy + `mode=race` inspection; WS behaviour (P1.7) must be
tested during US market hours per project rules.
