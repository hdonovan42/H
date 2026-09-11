# All-In: state transitions without a refresh (systemic fix)

Reported 2026-09-11: open the tracker pre-market, 1D dotted line = previous close; at 09:30 the
new session starts but the line never moves. User has patched many variants of this by hand.

## Root cause
Session-dependent numbers are **snapshots** captured at load (`quote.pc/o/h/l/volume`), and only
some transitions refetch them. Pre-market Yahoo `meta.previousClose` belongs to *yesterday's*
session (= close two sessions back); nothing refetches at the open, so it sticks all day.
Same class: day range, today-row open/high/low/volume, 6M+ charts frozen at load, 1D chart mixing
yesterday + today at the open, post-market never entered (`marketState.js:72`, audit P0.1).

Also found: today-row "open" is wrong on *every* load — `regularMarketOpen` is absent from Yahoo
meta, so it falls back to `quote.open[0]` of an includePrePost series = the 04:00 pre-market bar.

## Design
- [x] **Session model** (`marketState.js`): `hasTradedToday` + `getSessionDate` — the session the
      page shows. Previous close = close of the row before it (second-to-last spreadsheet row).
      Today row o/h/l/v derived from that session's own minute bars + live price. No snapshots.
- [x] **Market state**: after the bell, holiday-vs-normal-close is ambiguous from Alpaca's clock
      (next_open is tomorrow either way) — resolve with `tradedToday`; POST_MARKET now happens.
- [x] **One refresh path**: effect keyed on `(ticker, date|state)` reloads every dataset. Replaces
      first-clock-load refetch, close-edge refetch, and per-state intraday effect. chartCache gone.
- [x] **Charts**: 1D filters to the session date (no mixed days); 6M+ get the live session bar.
- [x] **Transition test** (`tests/transitions.mjs`): mocked worker + fake clock; one page lives
      through a week (pre-market, lagging open, settle, post, overnight, weekend, holiday, sleep)
      and must equal a cold load at every checkpoint, plus model-derived expected values.
- [x] Docs: CLAUDE.md market/spreadsheet section, CHANGELOG, lessons.

## Review (2026-09-11)

**Shipped locally, not yet committed/pushed** (main = live site).

- Transition test: 18/18 checkpoints equal a cold load + the model, two consecutive runs. Against
  the previous code: 83 failures, including the reported dotted-line one.
- Live smoke vs the real worker (13:51 ET): dotted $363.56 = 10 Sep close, open $364.14 (was
  $364.50), one-session 1D line, no page errors.
- Found during the work: the settle lock froze a preliminary close; a laptop waking after the bell
  showed "settling…" for 15 min — both fixed (official-close stamp; edge only counts for today's
  close inside the window).
- Harness note: two vite servers sharing one `node_modules/.vite` (symlinked baseline worktree)
  collide — run the test one checkout at a time.
- Open: confirm Yahoo stamps `regularMarketTime` = 16:00:00 at a real close (tonight). If not, the
  15-min backstop still locks the right value.
- Out of scope, still open from the July audit: "Last updated" shows wall-clock time (P0.5),
  earnings-page timezone (P0.2), worker-side earnings items.
