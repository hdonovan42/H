#!/usr/bin/env node
/**
 * Export Collecting Cars auction data to Excel.
 *
 * Uses Puppeteer to load the buy page, intercepts all Typesense search responses,
 * then scrolls/paginates to collect all listings and exports to .xlsx.
 *
 * Usage: cd projects/autosnipe && node scripts/export-collecting-cars.mjs
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '..', 'server', 'package.json'));

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const OUTPUT_DIR = resolve(__dirname, '..', 'exports');
const OUTPUT_FILE = resolve(OUTPUT_DIR, 'collecting_cars_dataset.xlsx');

// ── Approach: Replay the page's own XHR using its cookies/session ───────

async function extractData() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Capture the request details from the page's actual Typesense calls
  let capturedRequestInit = null;
  let capturedUrl = null;

  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    if (url.includes('dora.production.collecting.com') && url.includes('multi_search') && !capturedRequestInit) {
      capturedUrl = url;
      capturedRequestInit = {
        method: req.method(),
        headers: { ...req.headers() },
        body: req.postData(),
      };
      console.log('Captured request template');
    }
    req.continue();
  });

  console.log('Loading Collecting Cars buy page...');
  await page.goto('https://collectingcars.com/buy', {
    waitUntil: 'networkidle2',
    timeout: 60000,
  });
  await new Promise(r => setTimeout(r, 3000));

  if (!capturedRequestInit) {
    await browser.close();
    throw new Error('Failed to capture Typesense request');
  }

  // Parse the captured body to understand the search format
  const capturedBody = JSON.parse(capturedRequestInit.body);
  console.log('Captured search template:', JSON.stringify(capturedBody.searches[0]).slice(0, 200));

  // Now replay the request with pagination from inside the browser
  console.log('\nFetching all car listings...');

  const allHits = await page.evaluate(async (url, headers, searchTemplate) => {
    const hits = [];
    let pageNum = 1;
    const perPage = 250;
    let totalFound = 0;

    // Build search body based on captured template
    const search = { ...searchTemplate };
    search.per_page = perPage;
    search.filter_by = 'lotType:Car';
    delete search.facet_by;
    delete search.max_facet_values;
    delete search.facet_counts;
    delete search.facet_stats;
    delete search.facet_distribution;
    delete search.facet_return_parent;

    do {
      search.page = pageNum;

      const res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ searches: [search] }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.log(`API error page ${pageNum}: ${res.status} ${errText.slice(0, 200)}`);
        break;
      }

      const data = await res.json();
      const result = data.results?.[0];

      if (!result || !result.hits || result.hits.length === 0) break;

      totalFound = result.found || 0;
      hits.push(...result.hits.map(h => h.document));

      if (pageNum === 1) {
        console.log(`Total found: ${totalFound}`);
        console.log('Fields:', Object.keys(result.hits[0].document).sort().join(', '));
      }

      console.log(`Page ${pageNum}: ${result.hits.length} hits (${hits.length}/${totalFound})`);

      if (result.hits.length < perPage) break;
      pageNum++;
      await new Promise(r => setTimeout(r, 300));
    } while (hits.length < totalFound && pageNum <= 100);

    return hits;
  }, capturedUrl, capturedRequestInit.headers, capturedBody.searches[0]);

  console.log(`\nTotal listings collected: ${allHits.length}`);

  if (allHits.length > 0) {
    console.log('\nSample document:');
    const sample = allHits[0];
    for (const [key, val] of Object.entries(sample).sort((a, b) => a[0].localeCompare(b[0]))) {
      const display = typeof val === 'object' ? JSON.stringify(val)?.slice(0, 100) : String(val).slice(0, 100);
      console.log(`  ${key}: ${display}`);
    }
  }

  await browser.close();
  return allHits;
}

// ── Export to Excel ─────────────────────────────────────────────────────

function exportToExcel(listings) {
  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch {
    console.log('xlsx not available, using CSV');
    return exportToCsv(listings);
  }

  const rows = listings.map(doc => {
    const isSold = (doc.listingStage || doc.stage) === 'sold';
    const bid = doc.currentBid || doc.currentPrice || doc.price || '';
    // For sold listings, priceSold is often 0 (hidden) but currentBid = final hammer price
    const soldPrice = doc.priceSold > 0 ? doc.priceSold : (isSold ? bid : '');

    // Parse mileage from features if not a top-level field
    let mileage = '';
    if (doc.features?.mileage) {
      mileage = doc.features.mileage.replace(/,/g, '').replace(/\s*(miles|km|mi)$/i, '').trim();
    }

    return {
      'Title': doc.title || '',
      'Make': doc.productMake || doc.vehicleMake || '',
      'Model': doc.modelName || doc.productModel || '',
      'Generation': doc.generationName || '',
      'Variant': doc.variantName || '',
      'Year': doc.productYear || doc.productionYear || '',
      'Mileage': mileage,
      'Fuel Type': doc.features?.fuelType || '',
      'Transmission': doc.features?.transmission || '',
      'Drive Side': doc.features?.driveSide || doc.driveSide || '',
      'Powertrain': doc.powertrainName || '',
      'Current Bid': bid,
      'Sold Price': soldPrice,
      'Currency': doc.currencyCode || '',
      'No Reserve': doc.noReserve ?? '',
      'Reserve Met': doc.reserveMet ?? '',
      'Bids': doc.noBids || '',
      'Status': doc.listingStage || doc.stage || '',
      'Sale Format': doc.saleFormat || '',
      'Country': doc.countryCode || '',
      'Region': doc.regionCode || '',
      'Location': doc.location || '',
      'Seller Type': doc.vendorType || '',
      'Tags': Array.isArray(doc.tags) ? doc.tags.join(', ') : (doc.tags || ''),
      'Auction End': doc.dtStageEndsUTC || '',
      'URL': doc.slug ? `https://collectingcars.com/for-sale/${doc.slug}` : '',
      'Image': doc.mainImageUrl || '',
    };
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 55 }, // Title
    { wch: 16 }, // Make
    { wch: 16 }, // Model
    { wch: 12 }, // Generation
    { wch: 16 }, // Variant
    { wch: 6 },  // Year
    { wch: 10 }, // Mileage
    { wch: 10 }, // Fuel Type
    { wch: 12 }, // Transmission
    { wch: 10 }, // Drive Side
    { wch: 20 }, // Powertrain
    { wch: 14 }, // Current Bid
    { wch: 14 }, // Sold Price
    { wch: 6 },  // Currency
    { wch: 10 }, // No Reserve
    { wch: 10 }, // Reserve Met
    { wch: 6 },  // Bids
    { wch: 12 }, // Status
    { wch: 10 }, // Sale Format
    { wch: 6 },  // Country
    { wch: 10 }, // Region
    { wch: 16 }, // Location
    { wch: 10 }, // Seller Type
    { wch: 16 }, // Tags
    { wch: 20 }, // Auction End
    { wch: 55 }, // URL
    { wch: 55 }, // Image
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Listings');
  XLSX.writeFile(wb, OUTPUT_FILE);
  console.log(`\nSaved → ${OUTPUT_FILE}`);
  printStats(rows);
}

function exportToCsv(listings) {
  const rows = listings.map(doc => ({
    'Title': doc.title || '',
    'Make': doc.productMake || '',
    'Model': doc.productModel || '',
    'Year': doc.productYear || '',
    'Mileage': doc.mileage || '',
    'Current Bid': doc.currentBid || '',
    'Sold Price': doc.soldPrice || doc.hammerPrice || '',
    'Status': doc.listingStage || '',
    'Country': doc.countryCode || '',
    'URL': doc.slug ? `https://collectingcars.com/for-sale/${doc.slug}` : '',
  }));

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const csvFile = OUTPUT_FILE.replace('.xlsx', '.csv');
  const headers = Object.keys(rows[0] || {});
  const lines = [
    headers.join(','),
    ...rows.map(row =>
      headers.map(h => {
        const val = String(row[h] ?? '');
        return /[,"\n]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val;
      }).join(',')
    ),
  ];
  writeFileSync(csvFile, lines.join('\n'), 'utf8');
  console.log(`\nSaved → ${csvFile}`);
  printStats(rows);
}

function printStats(rows) {
  console.log(`Total rows: ${rows.length}`);
  const stages = {};
  for (const row of rows) {
    const s = row['Status'] || 'unknown';
    stages[s] = (stages[s] || 0) + 1;
  }
  console.log('\nBy status:');
  for (const [stage, count] of Object.entries(stages).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${stage}: ${count}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────

try {
  const listings = await extractData();
  if (listings.length === 0) {
    console.error('No listings found');
    process.exit(1);
  }
  exportToExcel(listings);
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
