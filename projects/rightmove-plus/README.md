# Rightmove Plus

Personal Chrome extension adding extra criteria to Rightmove search that the site itself
doesn't offer — starting with **listed buildings** (Rightmove's own keyword filter is
include-only; there is no way to exclude anything).

## Install (Chrome)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder (`projects/rightmove-plus`)
4. Run any Rightmove for-sale or to-rent search — a control pill appears bottom-right

After pulling changes, hit the ↻ reload icon on the extension card.

## What it does

Every result card gets a badge, and the pill filters the results:

| Mode | Behaviour |
|---|---|
| **Off** | Badges from card text only; no background checks |
| **Hide** | Hide listed buildings |
| **Only** | Show only listed buildings |
| **Not listed** | Show only properties whose listing **explicitly states** they are not listed — period-property character without the paperwork |

Badges: red `GRADE II LISTED` (grade captured where stated, including II*, Category A/B/C
Scotland, Grade B+/B1/B2 NI) · green `NOT LISTED` (explicit statement, e.g. "neither listed
nor situated within a conservation area") · amber `LISTED NEARBY?` (the description only
mentions a listed building nearby — "opposite the Grade II listed church") · `CHECKING…`
while the full description is being read. Hover a badge for the matching sentence.
"show" in the pill reveals hidden cards dimmed instead of removed.

## How it works

1. **Tier 1 (free):** card summary + key features (from the page's embedded `__NEXT_DATA__`
   JSON plus visible card text) are scanned with negation- and proximity-aware patterns.
   A positive "Grade II listed" here is final.
2. **Tier 2 (only when a filter mode is active):** absence of a claim proves nothing — the
   summary is truncated — so the property page is fetched (max 2 in flight, 300 ms gap,
   same as you clicking the card) and the full description + key features are extracted
   from Rightmove's `__PAGE_MODEL` payload, with a rendered-markup fallback.
3. **Cache:** verdicts live in `chrome.storage.local` for 30 days, keyed by property id and
   detector version, so each property is only ever fetched once.

Verdict priority: `listed` > `unlisted` > `mention` > `clear` — "the main house is Grade II
listed; the annexe is not listed" comes out listed.

## Development

```bash
node --test test/*.test.mjs     # 35 tests: detection cases + extraction against real pages
./test/fetch-fixtures.sh        # refresh gitignored fixtures from live Rightmove
```

`content/detect.js` and `content/extract.js` are pure (no DOM) and loaded by both the
browser and the tests.

## Limitations

- Detection is only as honest as the agent's description: an unmentioned listing is
  invisible (verdict `clear`, not `unlisted`). Cross-referencing Historic England's National
  Heritage List would catch those — future work.
- If you navigate from the Rightmove homepage without a full page load the content script
  may not inject; open search results directly or refresh once.
- Map view is not supported (list view only).

## CHANGELOG

### 0.1.1 — 2026-07-09

Fix: pagination broke (pages showed empty, stale badges). Root cause: Rightmove's React app
reuses card DOM nodes across pages, so per-node state (`rmpSeen`, hidden classes, injected
chip elements) leaked from one page to the next, and a MutationObserver feedback loop from
unguarded pill text writes kept rescanning. Now: badges are `::after` pseudo-elements driven
by data attributes (no children ever inserted into React-managed nodes), every scan is
idempotent (node reuse detected by property-id change → full reset), and every DOM write is
guarded to only fire on real change.

### 0.1.0 — 2026-07-09

First working version. Listed-building detection with four filter modes (Off / Hide /
Only / Not listed), explicit not-listed verdicts as a first-class feature, grade-aware
badges with evidence tooltips, throttled detail-page fetching, 30-day verdict cache,
SPA-pagination handling. 35 passing tests; end-to-end verified against live Rightmove
(tier-1 unlisted verdict + tier-2 Grade II verdict, model extraction path).
