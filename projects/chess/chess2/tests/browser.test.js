// End-to-end in headless Chrome, served the way GitHub Pages serves it: no
// COOP/COEP headers (coi-serviceworker supplies them) and real cache headers.
// Setup: npm install --no-package-lock   (puppeteer-core; uses the system Chrome,
// or CHROME_BIN). Run: npm run test:browser   (NETWORK=1 adds the Lichess fetch)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('../../../..', import.meta.url).pathname;  // the site root, so absolute paths resolve as on hjd.ai
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
let server, browser, url;

before(async () => {
  server = createServer((req, res) => {
    const file = join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
    if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
    const { size, mtimeMs } = statSync(file), etag = `"${size}-${mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) return res.writeHead(304).end();
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'max-age=600', ETag: etag });
    createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}/projects/chess/analysis.html`;  // chess2's public address
  const chrome = process.env.CHROME_BIN ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
});

after(async () => {
  await browser?.close();
  server?.close();
});

// A fresh page, cross-origin isolated (the service worker reloads once on first visit)
async function open(viewport = { width: 1440, height: 900 }, query = '') {
  const page = await browser.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => m.type() === 'error' && page.errors.push(m.text()));
  await page.setViewport(viewport);
  await page.goto(url + query);
  await until(page, () => self.crossOriginIsolated && document.querySelector('.board .piece'));
  return page;
}

async function until(page, fn, timeout = 30000, arg) {
  const end = Date.now() + timeout;
  for (;;) {
    try { if (await page.evaluate(fn, arg)) return; } catch { /* navigating */ }
    if (Date.now() > end) {
      const seen = await page.evaluate(() => ({ isolated: self.crossOriginIsolated,
        engine: document.querySelector('.engine .info')?.textContent, status: document.querySelector('.foot .status')?.textContent,
        review: document.querySelector('.graph')?.dataset.status, moves: document.querySelectorAll('.moves .move[data-id]').length,
      })).catch(e => e.message);
      throw new Error(`timed out waiting for ${fn}; page shows ${JSON.stringify(seen)}; errors ${JSON.stringify(page.errors)}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

const frame = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const fen = page => page.$eval('.board', el => el.dataset.fen.split(' ')[0]);
const current = page => page.$eval('.moves .cur', el => el.textContent).catch(() => null);

// A point inside `square` at fractions (fx, fy) of it, board seen from White
async function point(page, square, fx = 0.5, fy = 0.5) {
  const b = await page.$eval('.board', el => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
  return { x: b[0] + (square.charCodeAt(0) - 97 + fx) * b[2] / 8, y: b[1] + (8 - square[1] + fy) * b[3] / 8 };
}

async function drag(page, from, to, fx, fy, touch = false) {
  const a = await point(page, from), b = await point(page, to, fx, fy);
  if (touch) {
    await page.touchscreen.touchStart(a.x, a.y);
    await page.touchscreen.touchMove((a.x + b.x) / 2, (a.y + b.y) / 2);
    await page.touchscreen.touchMove(b.x, b.y);
    await page.touchscreen.touchEnd();
  } else {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
  }
  await frame(page);
}

async function click(page, square) {
  const p = await point(page, square);
  await page.mouse.click(p.x, p.y);
  await frame(page);
}

// Through a real paste event, as a person pasting would
async function paste(page, text) {
  await page.$eval('.load textarea', (el, t) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
  await frame(page);
}

const CORNERS = [0.03, 0.5, 0.97].flatMap(fy => [0.03, 0.5, 0.97].map(fx => [fx, fy]));

test('boots cleanly: lite arrows, then full Stockfish 19 takes over', async () => {
  const page = await open();
  await until(page, () => document.querySelectorAll('.arrows path').length > 0, 20000);
  await until(page, () => /^Stockfish 19 ·/.test(document.querySelector('.engine .info').textContent), 60000);
  assert.equal(await page.$$eval('.engine .lines li', l => l.length), 3);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('a drop lands on the square under the pointer: any size, zoom, transform or touch', async () => {
  const setups = [
    { name: 'desktop', viewport: { width: 1440, height: 900 } },
    { name: 'small window', viewport: { width: 900, height: 560 } },
    { name: 'CSS zoom 1.25', viewport: { width: 1440, height: 900 }, style: 'document.documentElement.style.zoom = "1.25"' },
    { name: 'transform 0.8', viewport: { width: 1440, height: 900 }, style: 'Object.assign(document.body.style, { transform: "scale(0.8) translate(40px, 30px)", transformOrigin: "0 0" })' },
    { name: 'phone, touch', viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }, touch: true },
  ];
  for (const s of setups) {
    const page = await open(s.viewport);
    if (s.style) { await page.evaluate(s.style); await frame(page); }
    for (const [to, expected] of [['e4', 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR'], ['e3', 'rnbqkbnr/pppppppp/8/8/8/4P3/PPPP1PPP/RNBQKBNR']]) {
      for (const [fx, fy] of CORNERS) {
        await drag(page, 'e2', to, fx, fy, s.touch);
        assert.equal(await fen(page), expected, `${s.name}: e2 → ${to} dropped at (${fx}, ${fy})`);
        await page.keyboard.press('ArrowLeft');
        await frame(page);
      }
    }
    // An illegal drop, and a drop off the board, both leave the position alone
    await drag(page, 'e2', 'e5', 0.5, 0.5, s.touch);
    await drag(page, 'e2', 'e4', 0.5, 9, s.touch);
    assert.equal(await fen(page), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', `${s.name}: illegal drops`);
    assert.deepEqual(page.errors, [], s.name);
    await page.close();
  }
});

test('click, click also moves; a click elsewhere cancels', async () => {
  const page = await open();
  await click(page, 'g1');
  assert.equal(await page.$$eval('.marks .dest', d => d.length), 2);
  await click(page, 'g4');  // not a destination: deselects
  assert.equal(await page.$$eval('.marks .dest', d => d.length), 0);
  await click(page, 'g1');
  await click(page, 'f3');
  assert.equal(await current(page), 'Nf3');
  await page.close();
});

test('promotion asks which piece, and can be dismissed', async () => {
  const page = await open();
  await paste(page, '8/P7/8/8/8/8/6k1/4K3 w - - 0 1');
  await drag(page, 'a7', 'a8', 0.5, 0.5);
  await until(page, () => document.querySelectorAll('.promotion button').length === 4, 3000);
  await page.mouse.click(...Object.values(await point(page, 'e4')));  // outside the chooser: dismiss
  await frame(page);
  assert.equal(await fen(page), '8/P7/8/8/8/8/6k1/4K3');
  await drag(page, 'a7', 'a8', 0.5, 0.5);
  await page.click('.promotion [data-piece="n"]');
  await frame(page);
  assert.equal(await current(page), 'a8=N');
  assert.equal(await fen(page), 'N7/8/8/8/8/8/6k1/4K3');
  await page.close();
});

// A real game: lichess.org/pb4aOR73, EricRosen–kyrgyznur, which lichess.org's
// own analysis scores at 93 (White) and 82 (Black)
const PGN = `[White "EricRosen"] [Black "kyrgyznur"] [WhiteElo "2534"] [BlackElo "1796"] [Result "1-0"]
1. e4 c5 2. Nc3 Nc6 3. Bb5 e6 4. Bxc6 bxc6 5. f3 Bb7 6. f4 d5 7. Nf3 Be7 8. O-O d4
9. Na4 c4 10. d3 c3 11. bxc3 dxc3 12. Nxc3 Bf6 13. e5 Be7 14. Rb1 Rb8 15. Ne4 Nh6
16. Be3 O-O 17. Bxa7 Nf5 18. Bxb8 Ne3 19. Qe2 Nxf1 20. Rxb7 Nxh2 21. Kxh2 1-0`;

test('a game is reviewed end to end, with accuracy, judgements and navigation', async () => {
  const page = await open();
  await paste(page, PGN);
  assert.equal(await page.$$eval('.moves .move[data-id]', m => m.length), 41);
  await until(page, () => document.querySelector('.graph').dataset.status === '' &&
    document.querySelectorAll('.player .acc').length === 2, 180000);
  const acc = await page.$$eval('.player .acc', a => a.map(e => parseInt(e.textContent)));
  console.log(`  accuracy ${acc.join(' / ')} (Black / White), lichess.org: 82 / 93`);
  acc.forEach(a => assert.ok(a >= 50 && a <= 100));
  assert.ok(await page.$eval('.graph .area', p => p.getAttribute('d').split('L').length > 40));

  // End, back two, then a side line by click-click; Escape returns to the game
  await page.keyboard.press('End');
  await frame(page);
  assert.equal(await current(page), 'Kxh2');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await frame(page);
  await click(page, 'd8');
  await click(page, 'c7');
  await until(page, () => document.querySelector('.alts')?.textContent.includes('Qc7'), 3000);
  await page.keyboard.press('Escape');
  await frame(page);
  assert.equal(await current(page), 'Rxb7');

  // Pressing on the graph seeks along the game
  const g = await page.$eval('.graph', el => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
  await page.mouse.click(g[0] + 1, g[1] + g[3] / 2);
  await frame(page);
  assert.equal(await fen(page), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
  assert.deepEqual(page.errors, []);
  await page.close();

  // The finished review was kept: the same game elsewhere is reviewed at once, identically
  const again = await open();
  await paste(again, PGN);
  await frame(again);
  assert.equal(await again.$eval('.graph', el => el.dataset.status), '');
  assert.deepEqual(await again.$$eval('.player .acc', a => a.map(e => parseInt(e.textContent))), acc);
  await again.close();
});

// Firefox private windows, for one, have no service workers: no isolation, no
// threads. The single-threaded lite build must then do everything.
test('without cross-origin isolation the single-threaded engine still analyses and reviews', async () => {
  const context = await browser.createBrowserContext();  // no service worker from earlier tests
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => m.type() === 'error' && page.errors.push(m.text()));
  await page.setRequestInterception(true);
  page.on('request', r => r.url().endsWith('coi-serviceworker.min.js')
    ? r.respond({ status: 200, contentType: 'text/javascript', body: '' }) : r.continue());
  await page.goto(url);
  // Generous ceilings: one thread is slow when other engines hold every core
  await until(page, () => /^Stockfish 19 Lite · depth/.test(document.querySelector('.engine .info').textContent), 60000);
  assert.equal(await page.evaluate(() => self.crossOriginIsolated), false);
  await paste(page, '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5 Qg5 5. Nxf7 Qxg2 6. Rf1 Qxe4+ 7. Be2 Nf3#');
  await until(page, () => document.querySelector('.graph').dataset.status === '' &&
    document.querySelectorAll('.player .acc').length === 2, 300000);
  await page.keyboard.press('End');
  await frame(page);
  assert.equal(await page.$eval('.engine .score', el => el.textContent), '0-1');
  assert.deepEqual(page.errors, []);
  await context.close();
});

test('a Lichess link loads the game', { skip: !process.env.NETWORK && 'set NETWORK=1' }, async () => {
  const page = await open(undefined, '?game=pb4aOR73&color=black');
  await until(page, () => document.querySelectorAll('.moves .move[data-id]').length === 41, 15000);
  assert.equal(await page.$eval('.player.bottom .name', n => n.textContent), 'kyrgyznur');
  await page.close();
});
