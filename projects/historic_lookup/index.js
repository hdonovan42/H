#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';

const WORKER_URL = 'https://dry-poetry-72b5.donovanh59.workers.dev';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function tsToDate(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

async function fetchChart(symbol, fromDate) {
  const period1 = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000) - 86400 * 7;
  const period2 = Math.floor(Date.now() / 1000);
  const url = `${WORKER_URL}/yahoo/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}&events=split`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.chart?.error) throw new Error(json.chart.error.description || 'upstream error');
  const result = json.chart?.result?.[0];
  if (!result) throw new Error('no data returned');
  return result;
}

function lookupTicker(result, requestedDate) {
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  if (!timestamps.length) throw new Error('no price data');

  let historicIdx = -1;
  for (let i = 0; i < timestamps.length; i++) {
    if (tsToDate(timestamps[i]) <= requestedDate) historicIdx = i;
    else break;
  }
  while (historicIdx >= 0 && closes[historicIdx] == null) historicIdx--;
  if (historicIdx < 0) throw new Error(`no data on or before ${requestedDate} (pre-IPO?)`);

  let latestIdx = closes.length - 1;
  while (latestIdx >= 0 && closes[latestIdx] == null) latestIdx--;
  if (latestIdx < 0) throw new Error('no latest close');

  const historicClose = closes[historicIdx];
  const historicDate = tsToDate(timestamps[historicIdx]);
  const latestClose = closes[latestIdx];
  const latestDate = tsToDate(timestamps[latestIdx]);

  const splits = result.events?.splits || {};
  let splitRatio = 1;
  for (const ts of Object.keys(splits)) {
    const d = tsToDate(parseInt(ts, 10));
    if (d > historicDate && d <= latestDate) {
      const s = splits[ts];
      splitRatio *= s.numerator / s.denominator;
    }
  }

  return {
    historicDate,
    historicClose,
    latestClose,
    latestDate,
    splitRatio,
    returnPct: ((latestClose - historicClose) / historicClose) * 100,
  };
}

function fmtMoney(n) {
  return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtPct(n) {
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

function fmtRatio(r) {
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

async function getInputs(argv) {
  if (argv.length === 0) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const tickersInput = (await rl.question('Tickers (comma-separated): ')).trim();
    const date = (await rl.question('Date (YYYY-MM-DD): ')).trim();
    rl.close();
    return {
      tickers: tickersInput.split(/[\s,]+/).filter(Boolean).map(t => t.toUpperCase()),
      date,
    };
  }

  const dateIdx = argv.findIndex(a => DATE_RE.test(a));
  if (dateIdx === -1) throw new Error('no date found in args (use YYYY-MM-DD)');
  const date = argv[dateIdx];
  const tickers = argv
    .filter((_, i) => i !== dateIdx)
    .flatMap(a => a.split(/[\s,]+/))
    .filter(Boolean)
    .map(t => t.toUpperCase());
  return { tickers, date };
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === '-h' || argv[0] === '--help') {
    console.log('Usage:');
    console.log('  historic_lookup                          # interactive');
    console.log('  historic_lookup TSLA,META 2022-10-23     # one-shot');
    console.log('  historic_lookup TSLA META 2022-10-23     # tickers can be space- or comma-separated');
    return;
  }

  let tickers, date;
  try {
    ({ tickers, date } = await getInputs(argv));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (!tickers.length) {
    console.error('no tickers provided');
    process.exit(1);
  }
  if (!DATE_RE.test(date)) {
    console.error(`invalid date: ${date} (expected YYYY-MM-DD)`);
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (date >= today) {
    console.error(`date must be before today (${today})`);
    process.exit(1);
  }

  const results = await Promise.all(tickers.map(async t => {
    try {
      const data = await fetchChart(t, date);
      return { ticker: t, ...lookupTicker(data, date) };
    } catch (e) {
      return { ticker: t, error: e.message };
    }
  }));

  console.log(`\nLookup: ${date} → today\n`);

  const headers = ['TICKER', 'THEN', 'NOW', 'RETURN', ''];
  const rows = results.map(r => {
    if (r.error) return [r.ticker, 'ERROR', '', '', r.error];
    const splitNote = r.splitRatio > 1 ? ` (1→${fmtRatio(r.splitRatio)})` : '';
    const dateNote = r.historicDate !== date ? `[${r.historicDate}]` : '';
    return [
      r.ticker,
      fmtMoney(r.historicClose) + splitNote,
      fmtMoney(r.latestClose),
      fmtPct(r.returnPct),
      dateNote,
    ];
  });

  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map(row => (row[i] || '').length)));
  for (const row of all) {
    console.log(row.map((c, i) => (c || '').padEnd(widths[i])).join('  ').trimEnd());
  }
  console.log();
}

main().catch(e => {
  if (e?.code === 'ABORT_ERR') process.exit(130);
  console.error(e.message || e);
  process.exit(1);
});
