# AutoSnipe — Changelog

All notable changes to AutoSnipe are documented here.

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
