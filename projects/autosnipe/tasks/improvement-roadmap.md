# AutoSnipe Improvement Roadmap

**Generated**: 2026-02-27 — by 3-agent review team (optimiser, features, reliability)

---

## Executive Summary

| Stream | Scope | Est. Effort | Timeline | ROI |
|--------|-------|-------------|----------|-----|
| **Foundation** | Fix critical bugs + enable features | 6h coding, 2h testing | Week 1-2 | Unblocks everything |
| **Quick Features** | Back-on-market + exclusion filters | 8h | Week 1 | High user value, zero overhead |
| **Optimisation** | Poll parallelisation, archival, monitoring | 12h | Week 2-4 | Enables advanced features, improves uptime |
| **Premium Features** | Price history, deal scoring, watchlist | 24h | Week 4-6 | Revenue tier justification |

**Total effort**: ~52 hours (1.3 weeks full-time, 3 weeks part-time)

**Revenue projection**: Price history + deal scoring + back-on-market justifies £9.99/mo premium tier.

**Uptime target**: 98% → 99.5% (43 min downtime/month vs current 1h+ per 2 days)

---

## Phase 0: Critical Blockers (Week 1, 8h)

*Must be fixed before shipping any features — else features fail silently or cascade.*

### 0.1 Concurrent Poll Race Condition — CRITICAL
- `isRunning` flag is non-atomic; two cron jobs can execute simultaneously causing duplicate notifications and data corruption
- **Fix**: Transaction-based poll locking via `locks` table
- **Blocks**: Back-on-market detection
- **Effort**: 2h

### 0.2 Token Refresh Race — HIGH
- Two simultaneous 401 responses both trigger refresh, wasting tokens
- **Fix**: Deduplicate with shared promise (`tokenRefreshPromise` singleton)
- **Blocks**: Deal scoring feature
- **Effort**: 1.5h

### 0.3 Promise Rejection Handling — HIGH
- Fire-and-forget polls fail silently; no admin alerting
- Users create search, see no results, assume broken
- **Fix**: Add `poll_status` column to searches (`pending|polling|success|error`), new `/api/searches/:id/poll-status` endpoint, frontend polling spinner
- **Effort**: 1h

### 0.4 Stripe Webhook Race Condition — CRITICAL
- `addSlot()` writes locally + Stripe webhook fires simultaneously → quantity out of sync
- User pays for 3 slots but DB shows 2 → "no available slots" error
- **Fix**: Always fetch fresh from Stripe (canonical truth), ACID transactions, webhook idempotency via `stripe_events` table + `stripe_subscription_version` column
- **Effort**: 2h

### 0.5 CWS Token Expiry Mid-Scrape — CRITICAL
- Token can expire between page 1 and page 2+ of results
- Returns partial results with `success: true` — user sees 20 listings when there are 100
- **Fix**: Reduce TTL from 23h to 22h, add 1h refresh buffer, proactive refresh if token >20h old before each page request, mark partial results as `success: false`
- **Effort**: 1.5h

### 0.6 WhatsApp SSH Command Injection — HIGH (Security)
- Listing titles are passed through shell via `execSync` — backticks or `$()` in titles = RCE on VPS
- **Fix**: Switch to `spawnSync` with array args (no shell interpretation) or escape shell metacharacters
- **Effort**: 0.5h

---

## Phase 1: Quick Wins (Week 1, 8h after Phase 0)

### 1.1 Back-on-Market Detection ⭐⭐⭐

| Metric | Rating |
|--------|--------|
| User Value | Very High — buyers want to know if they missed a chance |
| Revenue Impact | Very High — niche feature, hard to replicate |
| Effort | Low (2-3h) |
| Risk | Low |

- Track when listings vanish; flag if same car reappears after >14 days
- DB: Add `last_seen_at` timestamp + `listing_history` table
- WhatsApp alert: "BMW 3-Series back on market after 21 days — still interested?"
- UI: Badge "⚡ Back on market" on search card
- **Competitive edge**: CarGurus/Cazoo don't track disappearance patterns; Autotrader UI doesn't show time-off-market

### 1.2 Exclusion Filters ⭐⭐⭐

| Metric | Rating |
|--------|--------|
| User Value | Very High — eliminates manual filtering, saves search slots |
| Revenue Impact | Very High — reduces slot pressure, increases engagement |
| Effort | Low (3-4h) |
| Risk | Low |

- "BMW 3-Series, but NOT M-Sport" or "£20k-£30k, but exclude dealer 'Fast Motors'"
- DB: JSON `exclusions` column on searches table
- Post-fetch filtering (CWS API doesn't support exclusions natively)
- UI: Checkboxes in SearchEditor for seller types, colours, variants
- **Competitive edge**: Autotrader requires creating new searches for exclusions

---

## Phase 2: Optimisation Foundation (Week 2-3, 12h)

### 2.1 Poll Cycle Parallelisation
- Sequential polling (20 searches × 30s = 10 min) defeats polling interval
- **Fix**: Parallel batches of 5 with 1s stagger → cycle time ~3 min
- **Unblocks**: Watchlist feature (needs spare scheduler capacity)
- **Effort**: 2h

### 2.2 Stale Listings Archival
- Listings table grows unbounded (~300MB after 6 months)
- **Fix**: Monthly archive job moves 30-day-old listings to `listings_archive`
- **Unblocks**: Price history (storage concern resolved)
- **Effort**: 2h

### 2.3 SQLite Pragma Tuning
- Lock contention under concurrent requests
- **Fix**: `busy_timeout=10000`, `synchronous=NORMAL`, `cache_size=-64000`, `temp_store=MEMORY`
- Reduces lock contention ~70%, acceptable for <100 concurrent users
- **Effort**: 0.5h

### 2.4 WhatsApp Async Delivery
- `execSync` blocks event loop; slow WhatsApp sends block all polling
- **Fix**: Switch to `spawn` with 30s timeout, fire-and-forget
- **Effort**: 1.5h

### 2.5 Email Retry Logic
- Email failures aren't retried; user gets WhatsApp but misses email
- **Fix**: Exponential backoff retry (3 attempts)
- **Effort**: 1h

---

## Phase 3: Premium Features (Week 4-6, 24h)

### 3.1 Price History & Trend Alerts ⭐⭐⭐

| Metric | Rating |
|--------|--------|
| User Value | Very High — price drops are active buyer signal |
| Revenue Impact | Very High — core deal-hunting feature |
| Effort | Medium (5-6h) |
| Risk | Medium (DB bloat — mitigated by archival) |

- Track price changes per listing; flag >5% drops (>£500)
- New `price_history` table storing deltas only (not every poll)
- UI badge: "↓ £1,200 (15% since first seen)" + sparkline in expanded view
- WhatsApp: "BMW 3-Series £1,200 drop! Still £45k. [Link]"
- Premium: full trend line; free: new matches only
- **Reliability mitigation**: Archive after 90 days; weekly `PRAGMA optimize`

### 3.2 Deal Scoring (MVP) ⭐⭐⭐

| Metric | Rating |
|--------|--------|
| User Value | Very High — removes decision paralysis, surfaces bargains |
| Revenue Impact | Very High — justifies premium tier alone |
| Effort | Medium-High (6-8h) |
| Risk | Medium (compute cost — mitigated by facet-based approach) |

- Score each listing 0-100 based on percentile rank for same make/model/year/mileage/region
- Colour-coded: 🟢 80-100 "Top deal" / 🟡 50-79 "Fair price" / 🔴 0-49 "Premium"
- Computed weekly (not per-poll) using CWS API facets (free, no extra scraping)
- Free: simple regional average. Pro: per-trim breakdowns
- **Competitive edge**: CarGurus has this but needs own valuations; AutoSnipe computes from real-time Autotrader data

### 3.3 Market Average Widget ⭐⭐
- Per-poll regional stats: median, p25, p75 for each spec
- Badge: "15th percentile for this spec in your region"
- **Effort**: 2h

### 3.4 Watchlist / Favourites ⭐⭐

| Metric | Rating |
|--------|--------|
| User Value | High — natural UX pattern |
| Revenue Impact | Medium — engagement driver |
| Effort | Medium (5-6h) |
| Risk | Medium (scheduler overload — mitigated by separate queue) |

- Heart icon on listings → save to Watchlist
- Separate low-priority scheduler queue: re-check items weekly, cap 20/user
- Track status changes (sold/delisted) and price moves
- **Blocked by**: SQLite pragma tuning (Phase 2.3)

### 3.5 Notification Scheduling ⭐⭐
- Quiet hours, daily limits, per-user preferences
- JSON `notification_prefs` on users table
- Buffer excess alerts, deliver as digest during quiet window
- **Effort**: 2h

### 3.6 Seller Profiles ⭐⭐
- Aggregate seller stats (avg price, listing count, time-to-sell)
- Click dealer name → modal with all their listings (current + historical)
- Archive seller data >90 days; compute aggregates on-the-fly
- **Effort**: 4h

---

## Tier 3 & 4: Future Features

| Feature | Value | Effort | Timeline |
|---------|-------|--------|----------|
| Similar Cars Recommendations | Medium | Low (2-3h) | Week 3 |
| Weekly Market Digest Email | Medium | Medium (4-5h) | Week 4 |
| Search Templates / Saved Criteria | Low-Medium | Low (2h) | Week 3 |
| CSV Export / Share Search Link | Low-Medium | Low (3h) | Week 4 |
| Hot Markets Insights | Medium | High (6-7h) | Week 5+ |
| Listing Deprecation Tracking | Medium | High (8-10h) | Week 6+ |
| WhatsApp Command Replies | Medium | High (7-8h) | Week 6+ |

---

## Monitoring & Deploy Improvements

- **Enhanced health endpoint**: uptime, active searches, scheduler status, last poll time, token freshness
- **Structured JSON logging**: timestamp, level, context, message
- **Zero-downtime deploy**: graceful PM2 stop → npm ci → restart → health check

---

## Priority Matrix

```
              IMPLEMENTATION EFFORT
              Low        Medium       High
         ┌──────────┬────────────┬──────────┐
Very     │ Back-on- │ Price      │ Deal     │
High     │ Market   │ History    │ Scoring  │
Revenue  │ Exclusion│            │          │
         ├──────────┼────────────┼──────────┤
High     │ Quiet    │ Watchlist  │ Seller   │
         │ Hours    │            │ Profiles │
         ├──────────┼────────────┼──────────┤
Medium   │ Similar  │ Market     │ Hot      │
         │ Templates│ Digest     │ Markets  │
         ├──────────┼────────────┼──────────┤
Low      │ CSV      │ Deprecation│ WhatsApp │
         │ Export   │ Tracking   │ Commands │
         └──────────┴────────────┴──────────┘

START: Back-on-Market + Exclusions → Price History + Deal Scoring
```

---

## Additional Security & Reliability Quick Wins

| Fix | File | Effort | Impact |
|-----|------|--------|--------|
| `INSERT OR IGNORE` on listings | scheduler.js | 5 min | Prevents constraint violation crashes on concurrent polls |
| Magic link error messaging + daily cleanup | auth.js | 30 min | "This link was already used" instead of generic error |
| Browser heartbeat + stale process cleanup | browser.js | 1.5h | Prevents cascading OOM crashes from zombie Chrome |
| Poll log archival (>90 days) | scheduler.js | 15 min | Prevents unbounded DB growth (146K rows/year) |
| Async email sends (don't await in poll) | scheduler.js | 10 min | Removes 10s blocking per cycle |
| Taxonomy blocking guard flag | scheduler.js | 30 min | Prevents 30-min poll blackout every Monday |
| JWT subscription check on each request | auth.js | 30 min | Prevents cancelled users accessing paid features for 30 days |
| Admin endpoint auth (`X-Admin-Token` header) | index.js + auth.js | 30 min | Admin endpoints have zero app-level auth — anyone on VPS can call them (GDPR risk) |
| Graceful shutdown handler | index.js + ecosystem.config | 1h | PM2 kills after 10s; in-flight polls interrupted, listings lost. Extend to 60s + SIGTERM handler |

---

## Team Debate Resolutions

### 1. Browser Isolation (Optimiser ↔ Features)
Deal Scoring blocked until Taxonomy refresh gets browser isolation (currently locks scraper for 22 min). **Resolved**: Deal Scoring deferred to week 4.

### 2. Watchlist Scheduler Impact (Reliability ↔ Features)
100 users × 50 items = 5,000 extra polls per cycle. **Resolved**: Separate low-priority queue, weekly not per-cycle, cap 20 items/user. Deferred to week 5 after SQLite tuning.

### 3. Price History DB Bloat (Reliability ↔ Features)
Could grow 10-100x in 6 months. **Resolved**: Store deltas only (not every poll), archive after 90 days, weekly `PRAGMA optimize`.

### 4. Cloudflare Cost Control (Optimiser ↔ Features)
Deal Scoring backfill could spike CF solves. **Resolved**: Use CWS API facets (free) instead of full polling. Incremental weekly compute, not per-poll.

### 5. Manual Refresh Semantics (Optimiser ↔ Features)
**Resolved**: No priority queue needed. Merge into next batch (eventual consistency). Keeps it simple.

### 6. Parallelisation Timing (Reliability ↔ Optimiser)
Reliability flagged that parallelising polls BEFORE fixing the race condition reintroduces it. **Resolved**: Ship critical fixes first, monitor 24-48h, THEN parallelise with per-search inner transactions (`BEGIN IMMEDIATE`) + `Promise.allSettled`.

---

## Monetisation Strategy

- **Free tier**: Back-on-market + exclusion filters (stickiness)
- **Pro tier (£9.99/mo)**: Price history trends, deal scoring breakdown, watchlist, seller profiles, notification scheduling
- **Future higher tier**: Hot markets insights, WhatsApp commands, CSV export

---

## Success Metrics

| Metric | Current | Target | Timeline |
|--------|---------|--------|----------|
| Uptime | ~98% | 99.5% | Week 2 |
| Poll Cycle Time | 10-15 min | 3-5 min | Week 3 |
| Avg Response Time | 200ms | 80ms | Week 3 |
| DB Size | 200MB | 300MB (stabilised) | Week 4 |
| Feature Tier Conversion | 0% | 15-20% | Week 6 |
