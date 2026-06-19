# All-In Stock Tracker — Changelog

## 2026-06-19 — Close harmonisation: one price source + "settling" state

**Problem.** At the 16:00 ET close the page showed three contradicting "current price"
values. Watching a real close: the spreadsheet Today-close froze at the last live tick
($401.08) when the status light went red; the price box then showed an intermediate
$400.89 and later $400.49 (Yahoo's `regularMarketPrice` migrating from the last print to
the settled auction close); and the spreadsheet stayed at $401.08 until a manual refresh.
Root cause: three independent state atoms (`quote`, `data`, `currentMarketState`) on three
clocks/caches, no single source of truth, and no concept of a *settled official close*.

**Fix.** A regular-session phase machine — `live → settling → settled` — that the price
box, spreadsheet Today-close, status light and chart all read from one resolved value, so
they cannot diverge by construction.

- New `src/utils/pricePhase.js` — pure `determineInitialPhase` / `isStable` / `resolvePrice`.
- On the genuine market close (Alpaca `isOpen` true→false edge; robust to half-days, never
  false-fires on holidays) the page enters an amber **settling** state, polls the official
  close cache-bypassed every 15s until 3 consecutive cent-equal reads, then **locks** every
  view to it — no manual refresh. Backstop-locks the last value after 15 min.
- The box and spreadsheet Today-close are now the *same* resolved value; the `chg` column
  derives from it automatically.
- Gated the clock-driven re-fetch (E4) to first load only — kills the every-30s `quote.c`
  overwrite that produced the migrating number.
- Cold load after close: an evening visitor lands on `settled` immediately (no amber flash);
  only a load within 10 min of the bell, or a witnessed transition, shows settling.

**Tuning** (`src/utils/config.js`): `SETTLE_POLL_INTERVAL_MS=15000`, `SETTLE_STABLE_K=3`,
`SETTLE_TIMEOUT_MS=900000`, `SETTLE_COLD_WINDOW_MIN=10`.

**Verification.** 19 unit tests on the pure state machine pass; production build clean; all
modules transform cleanly in dev. Full in-browser E2E (faked-clock close, asserts
box ≡ spreadsheet ≡ official close) written but not run here — Chromium system libs are
unavailable in the dev environment.

**What to watch at the next close.** Devtools console logs `[settle] … settling official
close…` at 16:00 and `[settle] … official close locked at $X (N reads)` once it stabilises.
Confirm the status dot goes green → amber (with "settling…") → red, and that the box and the
spreadsheet Today-close show the same value the whole way down and lock together on the
official close without a refresh.
