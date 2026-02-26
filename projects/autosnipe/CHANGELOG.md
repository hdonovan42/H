# AutoSnipe — Changelog

All notable changes to AutoSnipe are documented here.

---

## v1.3.0 — Live Autotrader Taxonomy (26 Feb 2026)

**Deployed**: 26 Feb 2026 — `autosnipe-api` online, taxonomy populated

Replaced the hand-typed `models.json` (only VW populated, 16 models, 4 variants) with a live taxonomy scraped from Autotrader's GraphQL facets API. Navigates search pages in a CF-cleared browser session, intercepts batched `at-gateway` responses, and extracts `model` + `aggregated_trim` facets with listing counts.

### Results
- **42 makes, 1,133 models, 7,924 trims** — all populated automatically
- VW: 53 models (was 16), Golf: 56 trims (was 4)
- Listing counts shown in dropdowns: "Golf (8,835)" / "GTI (576)"
- Trims only fetched for models with >50 listings; trims with <2 listings excluded

### Architecture
- `server/taxonomy.js` — `refreshTaxonomy()` solves CF once, iterates makes, captures facets from batched GraphQL responses (`sr.facets` array, keyed by `.facet`), writes `server/data/taxonomy.json`
- Scheduler: `0 6 * * 1` (Monday 06:00 London) + stale-on-startup check (>8 days)
- `GET /api/taxonomy` serves cached JSON (503 if not yet generated)
- `POST /api/admin/refresh-taxonomy` for manual trigger
- SearchEditor fetches from API, populates model/variant dropdowns with counts
- Scraper: `aggregatedTrim` URL param + `aggregated_trim` GraphQL filter for variant searches
- Deploy: syncs `src/data/` to VPS for `makes.json` access

### Files Modified
| File | Change |
|------|--------|
| `server/taxonomy.js` | New — facet extraction from batched GraphQL responses |
| `server/scheduler.js` | Monday 06:00 taxonomy cron + startup refresh |
| `server/index.js` | `/api/taxonomy` + `/api/admin/refresh-taxonomy` endpoints |
| `server/scraper.js` | `aggregatedTrim` support in URL builder + GraphQL filters |
| `src/components/SearchEditor.jsx` | Live taxonomy fetch, counts in dropdowns |
| `src/data/models.json` | Deleted — replaced by live API |
| `deploy/deploy.sh` | Syncs `src/data/` to VPS |

### What to Watch
- `[Taxonomy]` log lines on Monday mornings — full refresh ~22 mins
- CF solve cost per refresh (~$0.008)
- Model/trim counts updating weekly in the dropdown

---

## v1.2.0 — Cloudflare Solver + Cost Optimisations (26 Feb 2026)

**Deployed**: 26 Feb 2026 — `autosnipe-api` online, PM2 pid 2969115

### Cloudflare Turnstile Solver
- Anthropic Computer Use (Haiku 4.5) agent loop to solve Cloudflare challenges
- New `server/cloudflare-solver.js` — screenshot → Claude → click → repeat (max 8 iterations)
- New `server/browser.js` — headed Puppeteer on Xvfb (`:99`, 1280×800), persistent user data dir, cookie banner dismissal
- Scraper rewritten to use headed browser with CF solver fallback
- Deploy script ensures Xvfb is running on VPS

### Computer Use Cost Optimisations
- **Screenshot stripping**: old screenshots replaced with `[previous screenshot]` text placeholder before each API call — saves ~80% of image input tokens on later iterations
- **Prompt caching**: system prompt and computer tool definition marked with `cache_control: { type: 'ephemeral' }` — 90% discount on cached tokens for back-to-back calls
- **Night-skipping**: polls skip midnight–6am London time — eliminates ~25% of daily API spend
- `calcCost()` updated to account for cache read/write token pricing

### Files Modified
| File | Change |
|------|--------|
| `server/cloudflare-solver.js` | New — CU agent loop with screenshot stripping + prompt caching |
| `server/browser.js` | New — headed Puppeteer browser management |
| `server/scraper.js` | Rewritten for headed browser + CF solver |
| `server/scheduler.js` | Night-skip guard (0:00–6:00 London) |
| `server/index.js` | Browser lifecycle integration |
| `server/package.json` | Puppeteer + dependencies |
| `shared/config.js` | `NIGHT_SKIP_START`, `NIGHT_SKIP_END` constants |
| `deploy/deploy.sh` | Xvfb check, rsync updates |
| `deploy/ecosystem.config.cjs` | `DISPLAY=:99` env var |
| `src/data/models.json` | Make/model data for search form |

### What to Watch
- Cache hit rate in logs (`[CF-Solver] Iteration N cache:` lines)
- Night skip logs at 0:00–6:00 London time
- `cost_estimate` in poll_log — compare against pre-optimisation polls

---

## v1.1.0 — Pay-Per-Slot Model (26 Feb 2026)

Replaced the free/pro subscription tier system with a simpler pay-per-slot model.

### New Pricing Model
- **1 free active search** for all users
- **£1 / $1 / €1** one-off payment per additional concurrent search slot — no subscription
- Only GBP, USD, and EUR accepted
- Slots are permanent once purchased

### Backend Changes
- `users` table: added `paid_slots` column (default 0), `tier` column retained but unused
- New `purchases` table tracking each slot purchase (user, Stripe session, currency, amount)
- Migration logic for existing databases (adds `paid_slots` if missing)
- Stripe integration rewritten: `payment` mode (not `subscription`), inline `price_data` at £1/$1/€1, idempotent webhook with duplicate-session guard
- `/api/auth/me` now returns `active_searches` and `max_searches` (computed as `1 + paid_slots`)
- Search creation limit: `FREE_SEARCHES + paid_slots` replaces old tier check
- `/api/stripe/checkout` now requires `currency` body param (`gbp`, `usd`, or `eur`)
- Admin users endpoint returns `paid_slots` instead of `tier`

### Frontend Changes
- **Buy Slot page** (`#/buy-slot`) replaces Upgrade page — currency picker (GBP/USD/EUR), single card showing "£1 one-off", Stripe checkout
- **NavBar**: tier badge replaced with `X/Y slots` counter
- **Settings**: shows "X/Y used (1 free + N purchased)" with "Buy More" link
- **SearchEditor**: auto-redirects to `#/buy-slot` when at slot limit

### Admin Dashboard
- "Tier" column replaced with "Slots" column showing `1+N` format

### Config
- `shared/config.js`: `FREE_SEARCHES`, `SLOT_PRICE`, `SUPPORTED_CURRENCIES`, `CURRENCY_SYMBOLS` replace old tier constants
- Version bumped to 1.1.0

---

## v1.0.0 — Initial Build (25 Feb 2026)

Full-stack used car search alerting system, built and deployed in a single session.

### Frontend (React 19 + Vite 6)
- **Landing page** with email input → magic link authentication
- **Dashboard** showing active searches and recent match feed
- **Search editor** — criteria form: make, model, price range, year range, mileage cap, fuel type, transmission, postcode, radius
- **Match feed** — chronological listing of discovered cars with price, specs, and Autotrader links
- **Search cards** — per-search summary with listing counts and last-checked timestamp
- **Settings page** — phone number management for WhatsApp alerts
- **Upgrade page** — Stripe checkout flow for Pro tier (£9.99/mo)
- **Navigation bar** with user info and logout
- Hash-based routing (`#/dashboard`, `#/new-search`, `#/settings`, `#/upgrade`)
- Dark theme with orange accent (`#FF6B00`), IBM Plex Mono throughout

### Backend (Express + SQLite)
- **Magic link auth** via Resend (verified `autosnipe.co.uk` domain), JWT sessions (30-day expiry)
- **SQLite schema** — `users`, `magic_links`, `searches`, `listings`, `poll_log` tables with WAL mode and foreign keys
- **Search CRUD** — create/list/deactivate searches with tier-enforced limits (1 free, 10 pro)
- **Autotrader URL builder** — constructs search URLs from structured criteria
- **Puppeteer scraper** — headless Chrome, cookie banner dismissal, DOM extraction of listing cards (title, price, mileage, year, fuel, transmission, location, seller type, image)
- **Scheduler** — croner-based cron job polling every 3 hours, deduplication via `autotrader_id`, sequential search processing with 2s inter-search pause
- **WhatsApp alerts** — moltbot SSH bridge, single and multi-listing message formats
- **Stripe integration** — checkout session creation, webhook handler for subscription events (upgrade on checkout.completed, downgrade on subscription.deleted)
- **Admin endpoints** — stats, user list, poll log (protected by nginx basic auth on subdomain)
- **Health endpoint** — uptime, active search count, total users
- Request logging middleware (method, path, status, duration)

### Admin Dashboard
- Standalone HTML page at `dash.autosnipe.co.uk`
- Stats cards (users, active searches, total listings)
- Users table (email, phone, tier, signup date)
- Poll log table (search name, status, found/new counts, iterations, timestamp)
- Auto-refresh every 30 seconds

### Infrastructure
- **Domain**: `autosnipe.co.uk` with SSL (Let's Encrypt)
- **VPS**: 89.167.4.126 — PM2 process `autosnipe-api` on port 3103
- **Nginx**: SSL termination, SPA fallback, API proxy to :3103
- **Docker**: Ubuntu + Xvfb + Firefox container for browser automation
- **Deploy script**: `deploy/deploy.sh` — Vite build → rsync (dist, server, shared, deploy) → npm ci → PM2 restart → Docker check
- **PM2 config**: auto-restart, 512MB memory limit, structured logging

### Freemium Model
- **Free tier**: 1 active search
- **Pro tier**: 10 active searches (£9.99/mo via Stripe)
- Tier limits enforced server-side at search creation

### Known Limitations
- **Scraping blocked**: Autotrader's Cloudflare Turnstile blocks all automated access (headless, headed+stealth, direct HTTP). Scraper code is in place but cannot currently bypass protection. Alternative approaches under investigation.
- **Stripe not configured**: Product/price/webhook keys not yet set up in production `.env`
- **Admin auth**: Admin endpoints rely solely on nginx basic auth — no app-level admin role
