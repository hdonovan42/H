# Rightmove Plus — MVP scaffold (2026-07-09)

Chrome MV3 extension adding extra filters to Rightmove search, starting with listed buildings.
Location: `projects/rightmove-plus/`

## Plan

- [x] Inspect recon samples for stable DOM anchors (search cards, detail description)
- [x] Scaffold: manifest.json (MV3, storage permission, content scripts on sale/rent search pages)
- [x] `content/detect.js` — pure verdict logic: grade/listed regexes, negation + proximity-context handling; node-testable
- [x] `content/cache.js` — chrome.storage.local verdict cache, TTL + detector-version invalidation
- [x] `content/fetcher.js` — throttled detail-page fetch queue (concurrency 2), description extraction
- [x] `content/extract.js` — pure extraction: `__PAGE_MODEL` index-reference decode + markup fallback + `__NEXT_DATA__` map (absorbed scan.js; card discovery lives in ui.js)
- [x] `content/ui.js` — FOUR-way toggle (Off / Hide / Only / Not listed), card badges, hidden/checking counts, MutationObserver for SPA pagination
- [x] `content/styles.css`
- [x] Tests: `test/detect.test.mjs` (30 cases) + `test/extract.test.mjs` against real-page fixtures (gitignored, `fetch-fixtures.sh` refreshes)
- [x] README with install steps + CHANGELOG
- [x] Commit

## Design decisions

- Tier 1 (card summary+keyFeatures) gives instant POSITIVE verdicts only; a definitive
  "not listed" always needs the full description → detail fetch. Cache makes this one-off per property.
- Mode Off = tier-1 badges only, no background fetching (politeness). Hide/Only = full pipeline.
- Verdicts: `listed` (red badge, grade captured) / `unlisted` (green — the listing EXPLICITLY states
  it is not listed; user request 2026-07-09: attractive = period character without the paperwork) /
  `mention` (amber — nearby/contextual, e.g. "opposite the Grade II listed church") / `clear`.
- Four modes: Off / Hide listed / Only listed / Not listed (shows only explicit `unlisted`).
- Negations ("neither listed nor…", "not listed", "unlisted") are positive evidence for `unlisted`,
  not just suppressed matches (real recon example: "The property is neither listed nor situated within
  a conservation area"). Priority: listed > unlisted > mention > clear.
- Tier-1 `unlisted` stays provisional (truncated summary could hide a "Grade II listed" further down);
  only the full description confirms it.

## Review (2026-07-09)

Shipped v0.1.0. 35/35 tests pass (`node --test test/*.test.mjs`).

**Verified end-to-end against live Rightmove:**
- Tier 1: keyword search page → 25 cards mapped; the "neither listed nor situated within a
  conservation area" property correctly verdicts `unlisted` from card data alone.
- Tier 2: property 171587372 fetched live → model extraction (2,920-char description +
  10 key features) → `listed / Grade II` with correct snippet.
- Markup fallback agrees with model extraction on the same page (tested by crippling the model).

**Gotcha captured:** the `__PAGE_MODEL` script block contains further statements after the
object, so extraction slices one balanced JSON object (string-aware brace matcher), not
"up to </script>".

**Not yet verified:** in-browser behaviour (badges, pill, hiding, storage) — needs H to load
it unpacked and run a real search. NHLE cross-reference for unmentioned listings = future work.
