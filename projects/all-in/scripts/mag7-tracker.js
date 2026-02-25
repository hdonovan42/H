#!/usr/bin/env node
// Monthly Magnificent 7 tracker — appends monthly snapshot to MagSeven.xlsx
// Usage: node mag7-tracker.js [--month "February 2026"] [--date 2026-02-02]
// --date forces historical price fetch for a specific trading day (for backfills)

import XLSX from 'xlsx';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const EXPORT_DIR = process.env.EXPORT_DIR || './exports';
const WORKER_URL = 'https://dry-poetry-72b5.donovanh59.workers.dev';
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

const MAG7 = ['NVDA', 'MSFT', 'AAPL', 'GOOGL', 'AMZN', 'META', 'TSLA'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// S&P 500 divisor — total market cap = index level × divisor
// Derived: $62T total / 6928 index (Feb 2026)
const SP500_DIVISOR = 8_950_000_000;

function getCurrentMonth() {
  const now = new Date();
  return `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
}

function parseMonthArg(raw) {
  const match = raw.match(/^(\w+)\s+(\d{4})$/);
  if (!match || !MONTHS.includes(match[1])) {
    console.error(`Invalid month format: "${raw}" (expected "February 2026")`);
    process.exit(1);
  }
  return `${match[1]} ${match[2]}`;
}

// Fetch close price for a specific date from Yahoo Finance chart
async function fetchHistoricalPrice(symbol, dateStr) {
  const target = new Date(dateStr + 'T00:00:00Z');
  const period1 = Math.floor(target.getTime() / 1000) - 86400; // day before
  const period2 = Math.floor(target.getTime() / 1000) + 86400; // day after
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${period1}&period2=${period2}`;
  const res = await fetch(url, { headers: YAHOO_HEADERS });
  if (!res.ok) throw new Error(`Yahoo error for ${symbol}: ${res.status}`);
  const data = await res.json();
  const result = data.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(`No data for ${symbol} on ${dateStr}`);
  // Find the close for the target date
  const timestamps = result.timestamp;
  const closes = result.indicators.quote[0].close;
  for (let i = 0; i < timestamps.length; i++) {
    const d = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
    if (d === dateStr && closes[i] != null) return closes[i];
  }
  // If exact date not found, return the closest available close
  return closes.find(c => c != null);
}

// Fetch S&P 500 index level for a specific date
async function fetchHistoricalIndex(dateStr) {
  const target = new Date(dateStr + 'T00:00:00Z');
  const period1 = Math.floor(target.getTime() / 1000) - 86400;
  const period2 = Math.floor(target.getTime() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&period1=${period1}&period2=${period2}`;
  const res = await fetch(url, { headers: YAHOO_HEADERS });
  if (!res.ok) throw new Error(`Yahoo error for ^GSPC: ${res.status}`);
  const data = await res.json();
  const result = data.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(`No index data for ${dateStr}`);
  const closes = result.indicators.quote[0].close;
  return closes.find(c => c != null);
}

// Fetch shares outstanding from the worker (FMP)
async function fetchSharesOutstanding(symbol) {
  const res = await fetch(`${WORKER_URL}/fmp/shares-float/${symbol}`);
  if (!res.ok) throw new Error(`FMP error for ${symbol}: ${res.status}`);
  const data = await res.json();
  return data[0]?.outstandingShares;
}

// Fetch current live data from the worker sp500-weight route
async function fetchLiveData() {
  const url = `${WORKER_URL}/fmp/sp500-weight?symbols=${MAG7.join(',')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Worker error: ${res.status}`);
  return res.json();
}

// Fetch historical data for a specific date
async function fetchHistoricalData(dateStr) {
  console.log(`  Using historical prices from ${dateStr}`);
  // Fetch all prices + shares outstanding in parallel
  const [prices, shares, indexLevel] = await Promise.all([
    Promise.all(MAG7.map(async s => ({ symbol: s, price: await fetchHistoricalPrice(s, dateStr) }))),
    Promise.all(MAG7.map(async s => ({ symbol: s, shares: await fetchSharesOutstanding(s) }))),
    fetchHistoricalIndex(dateStr),
  ]);

  const total = indexLevel * SP500_DIVISOR;
  const stocks = {};
  for (const { symbol, price } of prices) {
    const s = shares.find(x => x.symbol === symbol);
    const marketCap = price * (s?.shares || 0);
    stocks[symbol] = {
      price: Math.round(price * 100) / 100,
      marketCap,
      weight: (marketCap / total) * 100,
    };
  }
  return { total, stocks };
}

function monthExistsInSheet(ws, monthLabel) {
  if (!ws || !ws['!ref']) return false;
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
    if (cell && cell.v === monthLabel) return true;
  }
  return false;
}

function getNextRow(ws) {
  if (!ws || !ws['!ref']) return 0;
  const range = XLSX.utils.decode_range(ws['!ref']);
  return range.e.r + 1;
}

function setCell(ws, r, c, value, opts = {}) {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = { v: value, t: typeof value === 'number' ? 'n' : 's' };
  if (opts.bold) cell.s = { font: { bold: true } };
  if (opts.numFmt) cell.z = opts.numFmt;
  ws[addr] = cell;
}

function updateRange(ws, maxRow, maxCol) {
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  let monthLabel;
  let historicalDate = null;

  const mIdx = args.indexOf('--month');
  if (mIdx !== -1 && args[mIdx + 1]) {
    if (args[mIdx + 2] && /^\d{4}$/.test(args[mIdx + 2])) {
      monthLabel = parseMonthArg(`${args[mIdx + 1]} ${args[mIdx + 2]}`);
    } else {
      monthLabel = parseMonthArg(args[mIdx + 1]);
    }
  } else {
    monthLabel = getCurrentMonth();
  }

  const dIdx = args.indexOf('--date');
  if (dIdx !== -1 && args[dIdx + 1]) {
    historicalDate = args[dIdx + 1]; // YYYY-MM-DD
  }

  if (!existsSync(EXPORT_DIR)) {
    mkdirSync(EXPORT_DIR, { recursive: true });
  }

  const outputPath = join(EXPORT_DIR, 'MagSeven.xlsx');

  // Load or create workbook
  let wb, ws;
  if (existsSync(outputPath)) {
    wb = XLSX.readFile(outputPath);
    ws = wb.Sheets['Mag 7'];
  }
  if (!ws) {
    wb = wb || XLSX.utils.book_new();
    ws = {};
    ws['!cols'] = [
      { wch: 8 },   // Ticker
      { wch: 14 },  // Share Price
      { wch: 16 },  // Mkt Cap ($B)
      { wch: 14 },  // % of S&P 500
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Mag 7');
  }

  // Idempotent — skip if month already recorded
  if (monthExistsInSheet(ws, monthLabel)) {
    console.log(`${monthLabel} already in MagSeven.xlsx, skipping.`);
    process.exit(0);
  }

  console.log(`Fetching Mag 7 data for ${monthLabel}...`);
  const data = historicalDate
    ? await fetchHistoricalData(historicalDate)
    : await fetchLiveData();

  if (!data.stocks || Object.keys(data.stocks).length === 0) {
    console.error('No stock data returned.');
    process.exit(1);
  }

  // --- Append monthly block ---
  let row = getNextRow(ws);
  if (row > 0) row++; // blank separator

  // Month header (merged across all columns)
  setCell(ws, row, 0, monthLabel, { bold: true });
  ws['!merges'] = ws['!merges'] || [];
  ws['!merges'].push({ s: { r: row, c: 0 }, e: { r: row, c: 3 } });
  row++;

  // Column headers
  setCell(ws, row, 0, 'Ticker', { bold: true });
  setCell(ws, row, 1, 'Share Price', { bold: true });
  setCell(ws, row, 2, 'Mkt Cap ($B)', { bold: true });
  setCell(ws, row, 3, '% of S&P 500', { bold: true });
  row++;

  let totalMktCap = 0;
  let totalWeight = 0;

  // Stock rows
  for (const symbol of MAG7) {
    const stock = data.stocks[symbol];
    if (!stock) {
      console.error(`No data for ${symbol}, skipping row.`);
      setCell(ws, row, 0, symbol);
      row++;
      continue;
    }

    const mktCapB = stock.marketCap / 1e9;
    totalMktCap += mktCapB;
    totalWeight += stock.weight;

    setCell(ws, row, 0, symbol);
    setCell(ws, row, 1, stock.price, { numFmt: '$#,##0.00' });
    setCell(ws, row, 2, Math.round(mktCapB * 10) / 10, { numFmt: '$#,##0.0' });
    setCell(ws, row, 3, stock.weight / 100, { numFmt: '0.00%' });
    row++;
  }

  // Total row
  setCell(ws, row, 0, 'TOTAL', { bold: true });
  setCell(ws, row, 2, Math.round(totalMktCap * 10) / 10, { numFmt: '$#,##0.0', bold: true });
  setCell(ws, row, 3, totalWeight / 100, { numFmt: '0.00%', bold: true });

  updateRange(ws, row, 3);
  XLSX.writeFile(wb, outputPath);
  console.log(`Updated ${outputPath} with ${monthLabel}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
