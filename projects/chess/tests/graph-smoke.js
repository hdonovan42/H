// End-to-end graph smoke test: serves the app like GitHub Pages (static, no
// COOP/COEP headers — coi-serviceworker provides isolation), loads a PGN in
// headless Chrome and requires the auto graph pass to finish with every
// position evaluated, zero alert() popups and zero page errors.
//
// This is the test v2.9 lacked: the accuracy suite runs script.js in a vm
// sandbox and never executes the graph path, so a ReferenceError there
// (updateIncrementalAccuracy, deleted as "dead code") shipped and crashed
// every graph run in the browser.
//
// Setup (one-off):  npm install puppeteer-core  (anywhere on NODE_PATH)
//                   a Chrome under ~/.cache/puppeteer, or CHROME_BIN=<path>
//   If Chrome complains about libnspr4/libnss3 on a minimal box, extract the
//   debs locally (apt-get download libnspr4 libnss3; dpkg-deb -x) and point
//   LD_LIBRARY_PATH at the extracted lib dir.
// Run:  node tests/graph-smoke.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2], 10) || 8790;
const TIMEOUT_MS = 240000;

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const base = path.join(process.env.HOME, '.cache/puppeteer/chrome');
  const versions = fs.readdirSync(base).sort().reverse();
  for (const v of versions) {
    const bin = path.join(base, v, 'chrome-linux64/chrome');
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('No Chrome found — set CHROME_BIN');
}

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, urlPath === '/' ? 'analysis.html' : urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// 12-move miniature — long enough for a real sketch+polish pass, quick to finish
const PGN = '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 ' +
  '7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8';

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();

  const dialogs = [];
  const pageErrors = [];
  page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
  page.on('pageerror', e => pageErrors.push(String(e.message || e)));

  await page.goto(`http://localhost:${PORT}/analysis.html`, { waitUntil: 'networkidle2', timeout: 60000 });

  // coi-serviceworker reloads once on first visit (evaluate throws mid-reload —
  // swallow and retry); AppState is a top-level const, not a window property
  const bootStart = Date.now();
  let ready = false, isolated = false;
  while (Date.now() - bootStart < 90000 && !ready) {
    try {
      const s = await page.evaluate(() => ({
        iso: self.crossOriginIsolated,
        ready: typeof AppState !== 'undefined' && AppState.stockfishReady === true
      }));
      isolated = s.iso; ready = s.ready;
    } catch (e) { /* reload in flight */ }
    if (!ready) await new Promise(r => setTimeout(r, 500));
  }
  if (!ready) throw new Error('engine never became ready (isolated=' + isolated + ')');

  await page.evaluate(pgn => { loadPGNFromText(pgn); }, PGN);

  const start = Date.now();
  let state = { defined: 0, total: -1, active: true };
  while (Date.now() - start < TIMEOUT_MS && dialogs.length === 0) {
    state = await page.evaluate(() => ({
      active: AppState._graphRunActive,
      total: AppState.graphEvalHistory.length,
      defined: AppState.graphEvalHistory.filter(e => e !== undefined).length
    }));
    if (!state.active && state.defined === state.total) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  const accuracy = await page.evaluate(() => AppState.cachedAccuracy);
  await browser.close();
  server.close();

  const complete = state.defined === state.total && !state.active;
  console.log(`isolated=${isolated} graph=${state.defined}/${state.total} ` +
    `elapsed=${((Date.now() - start) / 1000).toFixed(1)}s ` +
    `accuracy=${accuracy ? accuracy.white + '/' + accuracy.black : 'none'}`);
  if (dialogs.length) console.log('DIALOGS:', dialogs);
  if (pageErrors.length) console.log('PAGE ERRORS:', pageErrors.slice(0, 5));

  if (!complete || dialogs.length || pageErrors.length) {
    console.log('FAIL');
    process.exit(1);
  }
  console.log('PASS — graph pass completed cleanly');
  process.exit(0);
})().catch(e => { console.error('SMOKE TEST ERROR:', e.message); process.exit(1); });
