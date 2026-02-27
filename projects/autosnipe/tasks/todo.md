# Scraper Hardening + CSS Fallback

## Completed

- [x] **Task 1: DB migrations** — Added `response_time_ms` (INTEGER) and `scraper_engine` (TEXT, default 'sss') columns to `poll_log`
- [x] **Task 2: Harden scraper.js**
  - [x] Added missing headers: `User-Agent`, `Accept-Encoding`, `Content-Type`, `platform-os-version`, `sss-version`
  - [x] Persistent `deviceId` — generated once, stored in `server/data/.device-id`
  - [x] Persistent `sessionId` — generated per token lifetime (not per request)
  - [x] `healthCheck()` function — canary BMW search, validates response shape, returns latency
  - [x] `scrapeSearch()` now returns `engine` and `responseTimeMs` in result object
  - [x] `scrapeSearch()` now throws on failure (allows caller to handle fallback)
  - [x] Version probing (7.49–7.60) on auth failure
  - [x] Exported shared functions for CSS module: `cwsFetch`, `getAccessToken`, `buildHeaders`, `CWS_BASE`, `COMPOSABLE_VERSION`
- [x] **Task 3: Create scraper-css.js** — CSS Core Search fallback module
  - [x] `cssSearch()` — same interface as `scrapeSearch()`
  - [x] `parseCssListings()` — maps CSS response format to our DB schema
  - [x] Criteria builder uses array types for list fields (make, model, etc.) per APK
  - [x] Uses curl subprocess to avoid Node.js charset=UTF-8 Content-Type issue
- [x] **Task 4: Wire fallback cascade in scheduler.js**
  - [x] `scrapeWithFallback()` — tries SSS, falls back to CSS, returns empty on both-fail
  - [x] `pollSingleSearch()` logs `response_time_ms` and `scraper_engine` to poll_log
  - [x] `runPollCycle()` runs health check before polling
- [x] **Task 5: Verification**
  - [x] All 4 files parse cleanly (import OK)
  - [x] SSS returns 100 listings in ~700ms with hardened headers
  - [x] Health check returns healthy in ~237ms
  - [x] Persistent device ID created and reused
  - [x] DB columns migrated successfully

## Known Limitations

### CSS endpoint not yet functional
- The CSS Core Search endpoint (`css/api/v1_17/core-search/1/search`) returns inconsistent results:
  - `application/x-www-form-urlencoded` → 415 "Unsupported Media Type" (server adds charset=UTF-8)
  - `application/json` → 500 (empty body, all body structures tried)
  - Load balancer occasionally routes to a backend that accepts form-encoded but returns auth errors (2001/2002)
- **Root cause**: The CSS backend appears to have inconsistent deployment across CWS servers
- **Impact**: CSS fallback will fail silently; the cascade gracefully degrades to empty results (same as pre-hardening SSS failures)
- **Next step**: Monitor the CSS endpoint for stability, or intercept real app traffic with mitmproxy to capture the exact request format

## Files Modified

1. `server/scraper.js` — hardened headers, persistent IDs, health check, version probing, exported shared functions
2. `server/scraper-css.js` — **NEW** — CSS Core Search fallback (architecture ready, endpoint TBD)
3. `server/db.js` — `response_time_ms` + `scraper_engine` columns on `poll_log`
4. `server/scheduler.js` — fallback cascade, health check, poll_log metrics
