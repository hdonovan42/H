// Transition test: does the tracker stay correct as the market moves between states
// WITHOUT a reload?
//
// One page is left open for a simulated week — overnight, pre-market, a lagging open,
// the close settling, post-market, a weekend, a holiday, and a laptop sleeping ~20h —
// on a fake clock, against a mocked worker. At every checkpoint it must (a) match a page
// freshly loaded at that moment and (b) match values derived from the market model.
// (a) is the invariant that matters: a page that lived through transitions must look
// exactly like a cold load. (b) catches the case where both are wrong.
//
//   npm run test:transitions            (needs Google Chrome at /usr/bin/google-chrome)
//   node tests/transitions.mjs <appDir> (test another checkout, e.g. a baseline)

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const APP_DIR = resolve(process.argv[2] || dirname(dirname(fileURLToPath(import.meta.url))));
const PORT = +process.env.PORT || 5199;
const APP_URL = `http://localhost:${PORT}/projects/all-in/index.html`;
const WORKER = 'https://dry-poetry-72b5.donovanh59.workers.dev';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';

// ── Calendar & clock helpers (all simulated sessions fall in EDT, UTC-4) ─────────────
const MIN = 60e3;
const OFFSET = 4 * 3600e3;
const et = (day, h = 0, m = 0, s = 0) => Date.parse(`${day}T00:00:00Z`) + OFFSET + ((h * 60 + m) * 60 + s) * 1000;
const dayOf = ms => new Date(ms - OFFSET).toISOString().slice(0, 10);
const minsOf = ms => { const d = new Date(ms - OFFSET); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const HOLIDAYS = new Set(['2026-09-07']); // Labor Day
const isTrading = day => { const wd = new Date(`${day}T00:00:00Z`).getUTCDay(); return wd > 0 && wd < 6 && !HOLIDAYS.has(day); };
const prevTrading = day => { let d = addDays(day, -1); while (!isTrading(d)) d = addDays(d, -1); return d; };
const nextTrading = day => { let d = addDays(day, 1); while (!isTrading(d)) d = addDays(d, 1); return d; };

// ── Deterministic market model ───────────────────────────────────────────────────────
const LAG = 90e3;          // Yahoo has no session data for the first 90 s after the bell
const SETTLE = 3 * MIN;    // regularMarketPrice shows a last-trade print before the official close
const hash = s => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 2 ** 32; };
const r2 = x => Math.round(x * 100) / 100;

const DAYS = [];
for (let d = '2021-06-01'; d <= '2026-12-31'; d = addDays(d, 1)) if (isTrading(d)) DAYS.push(d);
const OPEN = {}, CLOSE = {};
DAYS.forEach((d, i) => { // mean-reverting around $350 so five years of history stays plausible
  const base = 350 + 60 * Math.sin(i / 37);
  OPEN[d] = r2(base * (1 + (hash(d + 'o') - 0.5) * 0.03));
  CLOSE[d] = r2(OPEN[d] * (1 + (hash(d + 'c') - 0.5) * 0.05));
});

const regPrice = (d, i) => r2(OPEN[d] + (CLOSE[d] - OPEN[d]) * i / 389 + 3 * Math.sin(Math.PI * i / 389) * Math.sin(i / 7 + hash(d) * 6));
const regBar = (d, i) => {
  const open = i === 0 ? OPEN[d] : regPrice(d, i - 1), close = regPrice(d, i);
  return { t: et(d, 9, 30 + i) / 1000, open, close, high: r2(Math.max(open, close) + 0.05), low: r2(Math.min(open, close) - 0.05), volume: 20000 + Math.floor(hash(d + i) * 30000) };
};
const flatBar = (t, p, volume) => ({ t, open: p, high: p, low: p, close: p, volume });
const preBar = (d, j) => flatBar(et(d, 4, j) / 1000, r2(CLOSE[prevTrading(d)] + (OPEN[d] - CLOSE[prevTrading(d)]) * (j + 1) / 330), 2000);
const postBar = (d, k) => flatBar(et(d, 16, k) / 1000, r2(CLOSE[d] + 1.5 * Math.sin((k + 1) / 20)), 1500);
const agg = (bars, t) => ({ t, open: bars[0].open, close: bars.at(-1).close, high: Math.max(...bars.map(b => b.high)), low: Math.min(...bars.map(b => b.low)), volume: bars.reduce((s, b) => s + b.volume, 0) });
const range = n => [...Array(n).keys()];
const dailyMemo = new Map();
const fullDaily = d => { if (!dailyMemo.has(d)) dailyMemo.set(d, agg(range(390).map(i => regBar(d, i)), et(d, 9, 30) / 1000)); return dailyMemo.get(d); };

// What Yahoo can see at time T. `S` is the session Yahoo treats as current: yesterday's
// until the open (plus lag) — which is why its pre-market previousClose is two sessions back.
function view(T) {
  const D = dayOf(T), m = minsOf(T);
  const started = isTrading(D) && T >= et(D, 9, 30) + LAG;
  const S = started ? D : prevTrading(D);
  const n = S < D ? 390 : Math.min(390, Math.floor((T - et(D, 9, 30)) / MIN) + 1);
  const reg = range(n).map(i => regBar(S, i));
  let last = reg.at(-1).close;
  if (S === D && T >= et(D, 16)) last = T < et(D, 16) + SETTLE ? r2(CLOSE[D] + 0.37) : CLOSE[D];
  const dayAgg = { ...agg(reg, et(S, 9, 30) / 1000), close: last };
  return { T, D, m, S, n, reg, last, dayAgg, preOpen: isTrading(D) && m >= 240 && !started };
}

const metaFor = v => ({
  symbol: 'TSLA', shortName: 'Tesla, Inc.', currency: 'USD',
  regularMarketPrice: v.last, previousClose: CLOSE[prevTrading(v.S)], chartPreviousClose: CLOSE[prevTrading(v.S)],
  // Stamped with the last continuous-trading print until the official close lands at 16:00:00
  regularMarketTime: Math.floor((v.S < v.D ? et(v.S, 16) : v.T < et(v.D, 16) ? v.T : v.T < et(v.D, 16) + SETTLE ? et(v.D, 15, 59, 59) : et(v.D, 16)) / 1000),
  regularMarketDayHigh: v.dayAgg.high, regularMarketDayLow: v.dayAgg.low, regularMarketVolume: v.dayAgg.volume,
  fiftyTwoWeekHigh: 499.99, fiftyTwoWeekLow: 101.01,
});
const chart = (meta, bars) => ({ chart: { result: [{ meta, timestamp: bars.map(b => b.t), indicators: { quote: [{
  open: bars.map(b => b.open), high: bars.map(b => b.high), low: bars.map(b => b.low), close: bars.map(b => b.close), volume: bars.map(b => b.volume),
}] } }], error: null } });

function dailyBars(v) {
  const days = DAYS.filter(d => d < v.D && d <= v.S);
  const bars = days.map(fullDaily);
  if (v.S === v.D) bars.push(v.dayAgg);
  if (v.preOpen) { // adversarial: a premature bar dated today, before the session starts
    const pre = range(Math.min(330, v.m - 240 + 1)).map(j => preBar(v.D, j));
    bars.push(agg(pre, et(v.D, 9, 30) / 1000));
  }
  return bars;
}

function bucketed(v, days, size) {
  const out = [];
  for (const d of days) {
    const n = d === v.S ? v.n : 390;
    const reg = d === v.S ? v.reg : range(390).map(i => regBar(d, i));
    for (let k = 0; k * size < n; k++) out.push(agg(reg.slice(k * size, Math.min(n, (k + 1) * size)), et(d, 9, 30 + k * size) / 1000));
  }
  return out;
}

function yahoo(sym, q, T) {
  const v = view(T), meta = metaFor(v);
  const interval = q.get('interval'), rng = q.get('range');
  if (interval === '1m') {
    if (q.get('includePrePost') !== 'true') return chart(meta, v.reg);
    const P = isTrading(v.D) && v.m >= 240 ? v.D : v.S;
    const bars = [];
    const preN = P === v.D ? Math.min(330, v.m - 240 + 1) : 330;
    bars.push(...range(preN).map(j => preBar(P, j)));
    if (P === v.S) bars.push(...v.reg);
    const postN = P < v.D ? 240 : (T >= et(P, 16) ? Math.min(240, Math.floor((T - et(P, 16)) / MIN) + 1) : 0);
    bars.push(...range(postN).map(k => postBar(P, k)));
    return chart(meta, bars);
  }
  if (interval === '1d') {
    let bars = dailyBars(v);
    if (rng === '6mo') bars = bars.slice(-126);
    else if (rng === '5y') bars = bars.slice(-1260);
    else if (q.get('period1')) bars = bars.filter(b => b.t >= +q.get('period1') && b.t <= +q.get('period2'));
    return chart(meta, bars);
  }
  const sessions = n => DAYS.filter(d => d <= v.S).slice(-n);
  if (interval === '15m') return chart(meta, bucketed(v, sessions(5), 15));
  if (interval === '1h') return chart(meta, bucketed(v, sessions(60), 60));
  if (interval === '1mo') {
    const months = new Map();
    for (const b of dailyBars(v)) { const k = dayOf(b.t * 1000).slice(0, 7); (months.get(k) || months.set(k, []).get(k)).push(b); }
    return chart(meta, [...months.values()].map(bs => agg(bs, bs[0].t)));
  }
  return null;
}

function clock(T) {
  const D = dayOf(T);
  const isOpen = isTrading(D) && T >= et(D, 9, 30) && T < et(D, 16);
  const nextDay = isTrading(D) && T < et(D, 9, 30) ? D : nextTrading(D);
  return { is_open: isOpen, next_open: new Date(et(nextDay, 9, 30)).toISOString(), next_close: new Date(isOpen ? et(D, 16) : et(nextDay, 16)).toISOString(), timestamp: new Date(T).toISOString() };
}

function respond(route, T) {
  const url = new URL(route.request().url());
  const path = url.pathname;
  let body = null, status = 200;
  if (path === '/clock') body = clock(T);
  else if (path.startsWith('/yahoo/')) body = yahoo(path.split('/')[2], url.searchParams, T);
  else if (path.startsWith('/fmp/shares-float/')) body = [{ outstandingShares: 3.2e9 }];
  else if (path.startsWith('/finnhub/metric/')) body = { metric: { forwardPE: 150 } };
  else if (path.startsWith('/yahoo-earnings/')) body = { earningsDate: '2026-10-21', isEstimate: true };
  else if (path === '/exchange-rate') body = { rate: 0.74 };
  else if (path === '/finnhub/ws-url') status = 503; // exercise the REST fallback poll
  if (body === null && status === 200) status = 404;
  return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body ?? {}) });
}

// ── Expected values straight from the model ─────────────────────────────────────────
const money = x => `$${x.toFixed(2)}`;
function expected(T) {
  const D = dayOf(T), v = view(T);
  const S = isTrading(D) && T >= et(D, 9, 30) ? D : prevTrading(D); // the session the page shows
  const prevClose = CLOSE[prevTrading(S)];
  const price = S === D ? v.last : CLOSE[S];
  const chg = price - prevClose;
  const sign = chg >= 0 ? '+' : '';
  return {
    S, prevClose, price, lagging: S !== v.S,
    open: S === D && S !== v.S ? null : OPEN[S], // unknowable while Yahoo lags the open
    high: S < D ? fullDaily(S).high : null, low: S < D ? fullDaily(S).low : null,
    dotted: money(prevClose),
    change: `${sign}${chg.toFixed(2)} (${sign}${(chg / prevClose * 100).toFixed(2)}%)`,
  };
}

// ── Browser plumbing ────────────────────────────────────────────────────────────────
const pause = ms => new Promise(r => setTimeout(r, ms));
const pageErrors = [];
const consoleErrors = []; // printed only if the run crashes (503s from the mocked ws-url are expected)

async function openPage(browser, startMs) {
  const context = await browser.newContext({ timezoneId: 'Europe/London', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const p = { page, context, sim: { now: startMs } };
  await page.clock.install({ time: startMs });
  await page.route(`${WORKER}/**`, route => respond(route, p.sim.now));
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(APP_URL);
  await tick(p, 6);
  await page.getByRole('button', { name: '1D', exact: true }).click();
  await tick(p, 2);
  return p;
}

// Advance the fake clock in 1 s steps, letting the page's fetches resolve in real time.
async function tick(p, seconds) {
  for (let i = 0; i < seconds; i++) { p.sim.now += 1000; await p.page.clock.runFor(1000); await pause(10); }
  await pause(250);
}

// Jump without firing intermediate timers (at most once each) — a sleeping laptop.
async function jump(p, ms) { if (ms <= 0) return; p.sim.now += ms; await p.page.clock.fastForward(ms); await pause(100); }

const snapshot = page => page.evaluate(() => {
  const text = sel => document.querySelector(sel)?.textContent.trim() ?? null;
  const line = document.querySelector('.chart-box svg path[fill="none"]')?.getAttribute('d') || '';
  const xs = [...line.matchAll(/[ML] ([\d.]+) /g)].map(m => +m[1]);
  return {
    price: text('.price-current'),
    change: text('.price-change'),
    dot: document.querySelector('.status-dot')?.className.replace('status-dot', '').trim(),
    dotted: [...document.querySelectorAll('.chart-box svg text')].find(e => e.getAttribute('x') === '772')?.textContent ?? null,
    dayRange: text('.stats-grid .stat-value'),
    ext: text('.extended-hours-bar'),
    market: text('.timestamp span'),
    rows: [...document.querySelectorAll('.spreadsheet-row')].slice(0, 3).map(r => [...r.children].slice(0, 7).map(c => c.textContent.trim())),
    lineOneSession: xs.every((x, i) => i === 0 || x >= xs[i - 1]),
    linePoints: xs.length,
  };
});

// ── The simulated week ──────────────────────────────────────────────────────────────
// [label, checkpoint time, seconds of live ticking before it (crosses the transition)]
const TIMELINE = [
  ['Thu 03:30  overnight', et('2026-09-03', 3, 30, 30), 60],
  ['Thu 07:00  pre-market', et('2026-09-03', 7, 0, 30), 60],
  ['Thu 09:30  open, Yahoo still lagging', et('2026-09-03', 9, 30, 50), 110],
  ['Thu 09:35  open', et('2026-09-03', 9, 35, 30), 75],
  ['Thu 12:00  midday', et('2026-09-03', 12, 0, 30), 75],
  ['Thu 16:01  close settling', et('2026-09-03', 16, 1, 30), 120],
  ['Thu 16:20  post-market', et('2026-09-03', 16, 20, 30), 75],
  ['Thu 21:00  closed', et('2026-09-03', 21, 0, 30), 75],
  ['Fri 07:00  pre-market', et('2026-09-04', 7, 0, 30), 60],
  ['Fri 09:32  open (reported bug)', et('2026-09-04', 9, 32, 30), 240],
  ['Fri 14:00  afternoon', et('2026-09-04', 14, 0, 30), 75],
  ['Sat 10:00  weekend', et('2026-09-05', 10, 0, 30), 30],
  ['Mon 10:00  Labor Day', et('2026-09-07', 10, 0, 30), 30],
  ['Mon 17:00  Labor Day evening', et('2026-09-07', 17, 0, 30), 60],
  ['Tue 07:00  pre-market after holiday', et('2026-09-08', 7, 0, 30), 60],
  ['Tue 09:40  open', et('2026-09-08', 9, 40, 30), 75],
  ['Tue 17:00  post-market', et('2026-09-08', 17, 0, 30), 75],
  ['Wed 13:00  after ~20h laptop sleep', et('2026-09-09', 13, 0, 30), 3],
];

function check(label, live, fresh, exp) {
  const fails = [];
  const eq = (what, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${what}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
  // (a) survived-transitions page == cold load
  for (const k of ['price', 'change', 'dot', 'dotted', 'ext', 'market']) eq(`live≠fresh ${k}`, live[k], fresh[k]);
  eq('live≠fresh row date/open/close', live.rows.map(r => [r[0], r[1], r[4]]), fresh.rows.map(r => [r[0], r[1], r[4]]));
  eq('live≠fresh previous rows', live.rows.slice(1), fresh.rows.slice(1));
  // (b) both == the model
  for (const [who, s] of [['live', live], ['fresh', fresh]]) {
    eq(`${who} dotted line`, s.dotted, exp.dotted);
    eq(`${who} change`, s.change, exp.change);
    eq(`${who} price`, s.price, money(exp.price));
    eq(`${who} session row`, s.rows[0]?.[0], exp.S);
    eq(`${who} previous row close`, s.rows[1]?.[4], money(exp.prevClose));
    if (exp.open != null) eq(`${who} session open`, s.rows[0]?.[1], money(exp.open));
    if (exp.high != null) eq(`${who} day range`, s.dayRange, `${exp.low.toFixed(2)} - ${exp.high.toFixed(2)}`);
    if (!s.lineOneSession) fails.push(`${who} 1D line mixes sessions (x goes backwards)`);
    if (s.linePoints < 2) fails.push(`${who} 1D line empty`);
  }
  return fails;
}

async function main() {
  // Spawn vite itself (not via npx) so kill() reaches it and no server outlives the run
  const vite = spawn(resolve(APP_DIR, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  let viteErr = '';
  vite.stderr.on('data', d => { viteErr += d; });
  await new Promise((ok, fail) => {
    vite.stdout.on('data', d => { if (String(d).includes('Local')) ok(); });
    vite.on('exit', code => fail(new Error(`vite exited (${code}): ${viteErr.trim()}`)));
    setTimeout(() => fail(new Error('vite did not start')), 20000);
  });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  let failures = 0;
  try {
    const [first] = TIMELINE;
    const live = await openPage(browser, first[1] - first[2] * 1000);
    for (const [label, at, lead] of TIMELINE) {
      await jump(live, at - lead * 1000 - live.sim.now);
      await tick(live, lead);
      const fresh = await openPage(browser, at - 8000); // lands at `at` after its own ticks
      const [a, b] = [await snapshot(live.page), await snapshot(fresh.page)];
      await fresh.context.close();
      const fails = check(label, a, b, expected(at));
      failures += fails.length;
      console.log(`${fails.length ? '✗' : '✓'} ${label.padEnd(38)} session ${a.rows[0]?.[0] ?? '—'}  dotted ${a.dotted ?? '—'}  ${a.price ?? ''} ${a.change ?? ''}`);
      for (const f of fails) console.log(`    ${f}`);
    }
  } finally {
    await browser.close();
    vite.kill();
  }
  if (pageErrors.length) { console.log('\nPage errors:'); for (const e of [...new Set(pageErrors)]) console.log(`  ${e}`); }
  console.log(failures || pageErrors.length ? `\nFAILED — ${failures} check(s), ${pageErrors.length} page error(s)` : '\nAll transitions match a cold load.');
  process.exit(failures || pageErrors.length ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  for (const m of new Set([...pageErrors, ...consoleErrors])) console.error(`  page: ${m}`);
  process.exit(1);
});
