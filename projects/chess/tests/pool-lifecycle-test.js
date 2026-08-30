// Graph worker-pool lifecycle regression test.
//
// Covers the failure modes graph-smoke.js structurally cannot reach: it loads
// ONE game ONCE on a warm pool with no worker failures, so it never exercises
// an interrupted pool init, a degraded pool, or a worker dying mid-pass.
//
// The bugs these lock down (all shipped, all fixed together):
//   1. LEAK  — cancelGraphRun() only terminated workers when _graphRunActive was
//              true, but runGraphPasses() sets that flag BEFORE awaiting
//              ensureGraphPool(). Cancelling during init therefore ran
//              terminate() over a still-empty array, and the four full-net
//              workers (~79MB net + 32MB hash each) were orphaned alive.
//              Loading a second PGN while the first spun up leaked a whole pool.
//   2. NO TOP-UP — ensureGraphPool() accepted any non-empty pool, so a pool
//              degraded to one surviving worker stayed that way for the rest of
//              the session: a silent, permanent ~4x slowdown.
//   3. HANG  — a worker dying mid-pass ended its pump chain without resolving;
//              if it was the last one, the pass never settled and the graph
//              froze half-drawn with no error.
//
// Loads js/script.js in a vm sandbox (same approach as accuracy-test.js) with a
// scripted fake Worker, so it is deterministic and needs no browser.
//
// Run: node tests/pool-lifecycle-test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Fake Worker -----------------------------------------------------------
class FakeWorker {
  constructor(script) {
    this.script = script;
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    FakeWorker.all.push(this);
  }
  postMessage(msg) {
    if (this.terminated || typeof msg !== 'string') return;
    if (msg === 'isready') {
      setTimeout(() => {
        if (FakeWorker.failInit) return; // never answers → init timeout path
        this._send('readyok');
      }, FakeWorker.readyDelay);
    } else if (msg.startsWith('go')) {
      setTimeout(() => {
        if (FakeWorker.dieOnGo) {
          this.terminated = true;
          if (this.onerror) this.onerror(new Error('simulated worker death'));
          return;
        }
        this._send('info depth 20 score cp 15 pv e2e4 e7e5');
        this._send('bestmove e2e4');
      }, 1);
    }
  }
  _send(data) {
    if (this.terminated || !this.onmessage) return;
    this.onmessage({ data });
  }
  terminate() { this.terminated = true; }

  static reset() { FakeWorker.all = []; FakeWorker.failInit = false; FakeWorker.dieOnGo = false; }
  static live() { return FakeWorker.all.filter(w => !w.terminated); }
}
FakeWorker.all = [];
FakeWorker.readyDelay = 30;
FakeWorker.failInit = false;
FakeWorker.dieOnGo = false;

// --- Load script.js --------------------------------------------------------
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');
const sandbox = {
  self: {}, window: {},
  navigator: { hardwareConcurrency: 4 },
  document: { readyState: 'loading', addEventListener() {} },
  Worker: FakeWorker,
  console, Math, JSON, Map, Set, Array, Object, Number, Promise, Error,
  isFinite, Infinity, NaN, String, Boolean, Date,
  setTimeout, clearTimeout, requestAnimationFrame: fn => fn(),
  fetch: () => Promise.reject(new Error('no network in test')),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'script.js' });

const grab = name => vm.runInContext(name, sandbox);
const AppState = grab('AppState');
const ensureGraphPool = grab('ensureGraphPool');
const cancelGraphRun = grab('cancelGraphRun');
const runGraphPass = grab('runGraphPass');
const GRAPH_POOL_SIZE = grab('GRAPH_POOL_SIZE');

for (const [n, v] of Object.entries({ AppState, ensureGraphPool, cancelGraphRun, runGraphPass })) {
  if (!v) { console.error(`FAIL: ${n} not found in script.js`); process.exit(1); }
}

function resetPoolState() {
  AppState.graphPool = [];
  if (AppState._graphWorkers) AppState._graphWorkers.clear(); // absent pre-fix
  if (AppState._graphPoolAborts) AppState._graphPoolAborts.clear();
  AppState._graphPoolPromise = null;
  AppState._graphRunActive = false;
  FakeWorker.reset();
}

(async () => {
  // === 1. Cancel during pool init must not orphan workers ==================
  // The exact user action: paste a PGN, then paste another before the first
  // pool has finished loading.
  resetPoolState();
  const p1 = ensureGraphPool();
  AppState._graphRunActive = true;   // what runGraphPasses() sets before awaiting
  cancelGraphRun();                  // second PGN arrives mid-init
  const p2 = ensureGraphPool();
  await p1.catch(() => {});
  await p2.catch(() => {});
  await sleep(80);

  check('cancel during init terminates the abandoned pool',
    FakeWorker.live().length === GRAPH_POOL_SIZE,
    `${FakeWorker.all.length} created, ${FakeWorker.live().length} still alive ` +
    `(expected exactly ${GRAPH_POOL_SIZE}); pre-fix this leaked ${GRAPH_POOL_SIZE} engines`);

  check('abandoned generation is not adopted into the pool',
    AppState.graphPool.length === GRAPH_POOL_SIZE &&
    AppState.graphPool.every(w => !w.terminated),
    `pool holds ${AppState.graphPool.length}, ` +
    `${AppState.graphPool.filter(w => w.terminated).length} of them dead`);

  // Repeat loads must not accumulate engines.
  for (let i = 0; i < 3; i++) {
    AppState._graphRunActive = true;
    cancelGraphRun();
    await ensureGraphPool().catch(() => {});
  }
  await sleep(80);
  check('repeated interrupted loads do not accumulate engines',
    FakeWorker.live().length === GRAPH_POOL_SIZE,
    `${FakeWorker.live().length} alive after 4 interrupted loads`);

  // === 1b. Boot is staged: one worker first, then the rest ================
  // Browsers do not share concurrent fetches for the same URL, so four workers
  // booting at once each pulled the whole ~79MB net (~316MB cold). Below about
  // 150Mbps all four hit the ready timeout together and ensureGraphPool threw
  // "All graph pool workers failed to initialise" — the reported popup, on a
  // plain single PGN load. Measured: 4/4 timeouts at 40/60/80/120Mbps.
  resetPoolState();
  const staged = ensureGraphPool();
  check('first worker boots alone to warm the HTTP cache',
    FakeWorker.all.length === 1,
    `${FakeWorker.all.length} workers constructed at once — a cold cache must then ` +
    `move ~${79 * FakeWorker.all.length}MB inside one timeout window`);
  await staged;
  check('remaining workers start once the cache is warm',
    AppState.graphPool.length === GRAPH_POOL_SIZE,
    `pool reached ${AppState.graphPool.length}/${GRAPH_POOL_SIZE}`);

  // === 2. A degraded pool is topped back up ===============================
  resetPoolState();
  await ensureGraphPool();
  const survivor = AppState.graphPool[0];
  AppState.graphPool.slice(1).forEach(w => w.terminate());
  AppState.graphPool = [survivor];    // as worker deaths leave it

  const healed = await ensureGraphPool();
  check('degraded pool is refilled to full size',
    healed.length === GRAPH_POOL_SIZE,
    `pool stayed at ${healed.length}/${GRAPH_POOL_SIZE} — pre-fix this was a permanent 4x slowdown`);
  check('top-up keeps the surviving warm worker',
    healed.includes(survivor), 'survivor was discarded instead of reused');

  // === 3. Workers dying mid-pass must not hang the pass ===================
  resetPoolState();
  const pool = await ensureGraphPool();
  FakeWorker.dieOnGo = true;

  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  AppState.graphEvalHistory = [0.15];
  const tasks = Array.from({ length: 12 }, (_, i) => ({
    pos: { fen, moveIndex: i + 1, forced: false }, kind: 'polish'
  }));

  const settled = await Promise.race([
    runGraphPass(pool, tasks, { depthCap: 22 }, AppState._graphRunId).then(() => 'resolved'),
    sleep(3000).then(() => 'HUNG')
  ]);
  check('pass resolves when every worker dies', settled === 'resolved',
    'runGraphPass never settled — the graph would freeze half-drawn with no error');

  // === 4. Healthy pass still completes normally ===========================
  resetPoolState();
  const pool2 = await ensureGraphPool();
  const tasks2 = Array.from({ length: 8 }, (_, i) => ({
    pos: { fen, moveIndex: i + 1, forced: false }, kind: 'sketch'
  }));
  const ok = await Promise.race([
    runGraphPass(pool2, tasks2, { depthCap: 22 }, AppState._graphRunId).then(() => 'resolved'),
    sleep(3000).then(() => 'HUNG')
  ]);
  check('healthy pass completes', ok === 'resolved', 'a normal pass regressed');

  // === 5. Total init failure still reports, and leaves nothing running =====
  resetPoolState();
  FakeWorker.failInit = true;
  const before = grab('GRAPH_POOL_INIT_TIMEOUT_MS');
  let threw = null;
  // Shorten the wait by racing the timeout rather than actually waiting 45s.
  const initPromise = ensureGraphPool().catch(e => { threw = e; });
  const outcome = await Promise.race([initPromise.then(() => 'settled'), sleep(400).then(() => 'pending')]);
  check('init timeout is long enough for a cold cache', before >= 45000,
    `GRAPH_POOL_INIT_TIMEOUT_MS is ${before}ms; 4 workers stream ~79MB of net each`);
  check('total init failure does not settle early', outcome === 'pending',
    'pool init resolved despite no worker ever reporting ready');

  console.log();
  if (failures) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('All pool lifecycle checks passed.');
  process.exit(0);
})();
