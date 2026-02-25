#!/usr/bin/env node
// Quarterly TSLA OHLCV export — fetches from Yahoo Finance, saves as XLSX
// Usage: node quarterly-export.js [--quarter Q1'26]

import XLSX from 'xlsx';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const EXPORT_DIR = process.env.EXPORT_DIR || './exports';

// Quarter boundaries (month indices 0-based)
const QUARTER_START = { Q1: 0, Q2: 3, Q3: 6, Q4: 9 };

function getPreviousQuarter() {
  const now = new Date();
  const month = now.getMonth(); // 0-11
  const year = now.getFullYear();

  // Current quarter number (1-4)
  const currentQ = Math.floor(month / 3) + 1;

  // Previous quarter
  if (currentQ === 1) {
    return { quarter: 'Q4', year: year - 1 };
  }
  return { quarter: `Q${currentQ - 1}`, year };
}

function parseQuarterArg(arg) {
  // Parse Q1'26 format
  const match = arg.match(/^Q([1-4])'(\d{2})$/);
  if (!match) {
    console.error(`Invalid quarter format: ${arg} (expected Q1'26)`);
    process.exit(1);
  }
  return {
    quarter: `Q${match[1]}`,
    year: 2000 + parseInt(match[2]),
  };
}

function getQuarterDates(quarter, year) {
  const qNum = parseInt(quarter[1]);
  const startMonth = (qNum - 1) * 3; // 0, 3, 6, 9
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59)); // last day of quarter
  return { start, end };
}

function formatFilename(quarter, year) {
  const shortYear = String(year).slice(-2);
  return `${quarter}'${shortYear}.xlsx`;
}

async function fetchTSLA(startDate, endDate) {
  const period1 = Math.floor(startDate.getTime() / 1000);
  const period2 = Math.floor(endDate.getTime() / 1000);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/TSLA?interval=1d&period1=${period1}&period2=${period2}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const result = data.chart?.result?.[0];
  if (!result) {
    throw new Error('No data returned from Yahoo Finance');
  }

  return result;
}

function transformData(result) {
  const timestamps = result.timestamp;
  const quote = result.indicators.quote[0];
  const rows = [];

  for (let i = 0; i < timestamps.length; i++) {
    const date = new Date(timestamps[i] * 1000);
    const dateStr = date.toISOString().split('T')[0];

    const open = quote.open[i];
    const high = quote.high[i];
    const low = quote.low[i];
    const close = quote.close[i];
    const volume = quote.volume[i];

    // Skip days with null data (holidays etc.)
    if (close == null) continue;

    const prevClose = i > 0 ? quote.close[i - 1] : null;
    const changeDollar = prevClose != null ? close - prevClose : null;
    const changePct = prevClose != null && prevClose !== 0 ? (changeDollar / prevClose) * 100 : null;

    rows.push({
      Date: dateStr,
      Open: open != null ? Math.round(open * 100) / 100 : null,
      High: high != null ? Math.round(high * 100) / 100 : null,
      Low: low != null ? Math.round(low * 100) / 100 : null,
      Close: Math.round(close * 100) / 100,
      Volume: volume,
      'Change ($)': changeDollar != null ? Math.round(changeDollar * 100) / 100 : null,
      'Change (%)': changePct != null ? Math.round(changePct * 100) / 100 : null,
    });
  }

  return rows;
}

function generateXLSX(rows, sheetName, outputPath) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  // Auto-column-widths
  const colWidths = Object.keys(rows[0]).map((key) => {
    const maxLen = Math.max(
      key.length,
      ...rows.map((r) => String(r[key] ?? '').length)
    );
    return { wch: maxLen + 2 };
  });
  ws['!cols'] = colWidths;

  // Bold header row
  const headerRange = XLSX.utils.decode_range(ws['!ref']);
  for (let c = headerRange.s.c; c <= headerRange.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) {
      ws[addr].s = { font: { bold: true } };
    }
  }

  // Number formats for dollar columns
  for (let r = 1; r <= rows.length; r++) {
    // Open, High, Low, Close (cols 1-4) — dollar format
    for (const c of [1, 2, 3, 4]) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr] && ws[addr].v != null) {
        ws[addr].z = '$#,##0.00';
      }
    }
    // Volume (col 5) — number with commas
    const volAddr = XLSX.utils.encode_cell({ r, c: 5 });
    if (ws[volAddr] && ws[volAddr].v != null) {
      ws[volAddr].z = '#,##0';
    }
    // Change $ (col 6)
    const chgAddr = XLSX.utils.encode_cell({ r, c: 6 });
    if (ws[chgAddr] && ws[chgAddr].v != null) {
      ws[chgAddr].z = '+$#,##0.00;-$#,##0.00';
    }
    // Change % (col 7)
    const pctAddr = XLSX.utils.encode_cell({ r, c: 7 });
    if (ws[pctAddr] && ws[pctAddr].v != null) {
      ws[pctAddr].z = '+0.00%;-0.00%';
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, outputPath);
}

// --- Main ---
async function main() {
  // Parse args
  const args = process.argv.slice(2);
  let quarterInfo;

  const qIdx = args.indexOf('--quarter');
  if (qIdx !== -1 && args[qIdx + 1]) {
    quarterInfo = parseQuarterArg(args[qIdx + 1]);
  } else {
    quarterInfo = getPreviousQuarter();
  }

  const { quarter, year } = quarterInfo;
  const filename = formatFilename(quarter, year);
  const sheetName = `TSLA ${quarter}'${String(year).slice(-2)}`;

  // Ensure export directory exists
  if (!existsSync(EXPORT_DIR)) {
    mkdirSync(EXPORT_DIR, { recursive: true });
  }

  const outputPath = join(EXPORT_DIR, filename);

  // Idempotent — skip if already exists
  if (existsSync(outputPath)) {
    console.log(`${filename} already exists, skipping.`);
    process.exit(0);
  }

  const { start, end } = getQuarterDates(quarter, year);
  console.log(`Fetching TSLA data for ${quarter}'${String(year).slice(-2)}: ${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}`);

  const result = await fetchTSLA(start, end);
  const rows = transformData(result);

  if (rows.length === 0) {
    console.error('No trading data found for this quarter.');
    process.exit(1);
  }

  generateXLSX(rows, sheetName, outputPath);
  console.log(`Saved ${outputPath} (${rows.length} trading days)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
