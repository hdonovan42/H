// Market-state classification matrix (P0.1 regression) — drives the REAL
// src/utils/marketState.js (bundled via esbuild, as Vite would resolve it) with a
// frozen wall-clock and mocked Alpaca clock data. Covers the post-market-vs-
// holiday ambiguity: after the 4pm close next_open is always the NEXT day, which
// must not flag an ordinary evening as a holiday (that froze post-market prices).
//   node scripts/test-market-state.mjs
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = await mkdtemp(join(tmpdir(), 'ms-test-'));
const bundle = join(outDir, 'marketState.bundle.mjs');
await build({
  entryPoints: [join(projectRoot, 'src/utils/marketState.js')],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error'
});
const { getMarketState, MarketState } = await import(pathToFileURL(bundle).href);

const RealDate = Date;
function freezeAt(iso) {
  const t = new RealDate(iso).getTime();
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length) { super(...a); } else { super(t); } }
    static now() { return t; }
  };
}

const cases = [
  // [label, frozen now, clockData, expected state, expected isHoliday]
  ['normal Mon 17:30 ET → POST_MARKET (was CLOSED pre-fix)',
    '2026-07-06T17:30:00-04:00',
    { isOpen: false, nextOpen: '2026-07-07T09:30:00-04:00', nextClose: '2026-07-07T16:00:00-04:00' },
    MarketState.POST_MARKET, false],
  ['normal Mon 08:00 ET → PRE_MARKET',
    '2026-07-06T08:00:00-04:00',
    { isOpen: false, nextOpen: '2026-07-06T09:30:00-04:00', nextClose: '2026-07-06T16:00:00-04:00' },
    MarketState.PRE_MARKET, false],
  ['normal Mon 10:30 ET, isOpen → OPEN',
    '2026-07-06T10:30:00-04:00',
    { isOpen: true, nextOpen: '2026-07-07T09:30:00-04:00', nextClose: '2026-07-06T16:00:00-04:00' },
    MarketState.OPEN, false],
  ['normal Mon 21:30 ET → CLOSED',
    '2026-07-06T21:30:00-04:00',
    { isOpen: false, nextOpen: '2026-07-07T09:30:00-04:00', nextClose: '2026-07-07T16:00:00-04:00' },
    MarketState.CLOSED, false],
  ['holiday (Thanksgiving Thu) 08:00 ET → CLOSED, isHoliday',
    '2026-11-26T08:00:00-05:00',
    { isOpen: false, nextOpen: '2026-11-27T09:30:00-05:00', nextClose: '2026-11-27T13:00:00-05:00' },
    MarketState.CLOSED, true],
  ['holiday 12:00 ET → CLOSED (midday falls through no branch)',
    '2026-11-26T12:00:00-05:00',
    { isOpen: false, nextOpen: '2026-11-27T09:30:00-05:00', nextClose: '2026-11-27T13:00:00-05:00' },
    MarketState.CLOSED, false],
  ['holiday 17:00 ET → POST_MARKET (documented trade-off; today-row guarded by tradingDay)',
    '2026-11-26T17:00:00-05:00',
    { isOpen: false, nextOpen: '2026-11-27T09:30:00-05:00', nextClose: '2026-11-27T13:00:00-05:00' },
    MarketState.POST_MARKET, false],
  ['weekend Sat 12:00 ET → CLOSED',
    '2026-07-04T12:00:00-04:00',
    { isOpen: false, nextOpen: '2026-07-06T09:30:00-04:00', nextClose: '2026-07-06T16:00:00-04:00' },
    MarketState.CLOSED, false],
];

let failed = 0;
for (const [label, nowIso, clock, wantState, wantHoliday] of cases) {
  freezeAt(nowIso);
  const r = getMarketState(clock);
  const ok = r.state === wantState && r.isHoliday === wantHoliday;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` +
    (ok ? '' : `  [got state=${r.state} isHoliday=${r.isHoliday}, want ${wantState}/${wantHoliday}]`));
}
global.Date = RealDate;
await rm(outDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
