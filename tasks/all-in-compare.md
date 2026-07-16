# All-In: Compare page (TSLA divestment analysis)

Plan: ~/.claude/plans/cheerful-wandering-sifakis.md — approved 2026-07-16

## v2 (same day): timeframes, price format, magic-link accounts, CHANGELOG

- [x] A. Tweaks: ranges 3M/6M/1Y (default 1Y), price override → 2 dp on commit, header "Portfolio"
- [x] B. Worker: AUTH_STORE KV (3d1b0242…) + sha256/token helpers + /auth/request|verify + /portfolios save/rename/delete + rate limit + Resend send w/ dev echo
- [x] C. wrangler dev + curl: all 19 API cases pass (single-use token, 409s, 401s, 429 after 5, 20-cap, overwrite)
- [x] D. Frontend: VITE_WORKER_URL override, accountApi.js, AccountPanel.jsx, CompareTracker wiring, compare.css
- [x] E. Headless UI verify vs local worker: sign-in via link, token stripped from URL, save/load/rename-conflict/two-click-delete/reload-session/sign-out/reused-link all pass; build clean
- [x] F. Docs: CHANGELOG.md (new), SKILL.md update, this file's review
- [x] G. Shipped 2026-07-16: commit 6b55ccc pushed, worker version c519c8e1 deployed, live smoke
      clean (1Y default, chart renders, sign-in shows expected "not configured" 503).
      REMAINING (user): Resend signup → verify send.hjd.ai → `npx wrangler secret put RESEND_API_KEY_ENV`

**v2 review**: production email sending blocked on user's Resend setup by design (503 + friendly
UI message until `RESEND_API_KEY_ENV` is set). SIGNIN_FROM = signin@send.hjd.ai — must match the
Resend-verified domain.

## v1 — DONE (see review below)

- [x] 1. Wiring: vite.config input + compare.html + src/compare.jsx + stub CompareTracker → serves on :5173
- [x] 2. api.js: move backfillLatestClose + parseYahooBars in as exports; StockTracker imports them
- [x] 3. CompareTracker data layer: bars (1y daily) + quotes (60s poll), symbol chips add/remove/validate, localStorage `compare_portfolio_v1`
- [x] 4. Series maths (swap/ratio/indexed) + CompareChart (multi-series SVG, legend, hover)
- [x] 5. Portfolio table: shares input, price autofill + override (amber + ↺ reset), value, weight %, totals
- [x] 6. compare.css polish + main-page header link (.page-link) + 700px mobile pass
- [x] 7. Verify locally: dev server, all modes/ranges, SPCX short history, add/remove ticker, persistence, main-page regression, build
- [x] Review section (below) after completion

## Review (2026-07-16)

**Built**: new `compare.html` page (4th entry point) at /projects/all-in/compare.html.
TSLA pinned + SPCX/GOOGL/PLTR defaults, one free slot (5 symbols max), swap-rate
(TSLA÷X, default) / ratio / indexed-to-100 chart over 5D–1Y, and a what-if portfolio
table (editable shares, live price with manual override + ↺ reset, value, weight %),
persisted in localStorage `compare_portfolio_v1`.

**Verified headless** (Playwright vs live worker data):
- Swap legend TSLA÷SPCX 2.97 / ÷GOOGL 1.10 / ÷PLTR 2.91 — matches live prices
- SPCX (SpaceX, IPO 12 Jun 2026) clips correctly in all modes + indexed footnote
- Junk ticker ZZZZQ rejected; NVDA added as 5th (input hides at max), removed cleanly
- Portfolio maths (66.1/33.9% weights), override amber + reset-to-live, reload persistence
- Persistence survives main-page ticker changes (clearCaches doesn't touch the key)
- Main page regression clean; `npm run build` emits dist/compare.html
- 390px mobile pass

**Not done (pending user review)**: commit/push (main = live public site), worker untouched.
Pre-existing issue seen in passing: main-page Finnhub WS handshake 500s in a second
concurrent session (free tier = 1 connection) — REST fallback covers it; not from this change.

**Findings**: user's remembered "5 max" was the ticker input's maxLength=5 (characters,
not symbols); the SPCX ticker is Space Exploration Technologies Corp. on NasdaqGS.
