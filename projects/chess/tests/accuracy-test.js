// Accuracy regression test — validates the app's calculateGameAccuracy against
// OFFICIAL lichess.org accuracy numbers on 12 real server-analysed games
// (tests/lichess-accuracy-fixtures.json, fetched 2026-07-04 via the Lichess API
// with evals=true&accuracy=true).
//
// Loads js/script.js itself in a sandbox — single source of truth, no copied
// formulas. The implementation is an exact port of lila's AccuracyPercent;
// every game must match the official number within ±0.6 (display rounding).
//
// Run: node tests/accuracy-test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TOLERANCE = 0.6;

// --- Load script.js with browser stubs (init is deferred by readyState) ---
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'script.js'), 'utf8');
const sandbox = {
  self: {},
  window: {},
  navigator: { hardwareConcurrency: 4 },
  document: { readyState: 'loading', addEventListener() {} },
  console, Math, JSON, Map, Set, Array, Object, Number, isFinite, Infinity, NaN,
  setTimeout, clearTimeout, requestAnimationFrame: fn => fn(),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'script.js' });

// const/let bindings live in the context's lexical scope, not on the global
// object — pull them out from inside the context
const AppState = vm.runInContext('AppState', sandbox);
const calculateGameAccuracy = vm.runInContext('calculateGameAccuracy', sandbox);
if (typeof calculateGameAccuracy !== 'function' || !AppState) {
  console.error('FAIL: calculateGameAccuracy/AppState not found in script.js');
  process.exit(1);
}

// --- Convert lichess evals using the app's own graph conventions ---
// (White-POV pawns, ±10 clamp, mate → ±(10 + 5/|mate|), initial 0.15)
function toGraphHistory(evals) {
  const hist = [0.15];
  for (const e of evals) {
    if (e.mate !== undefined) {
      hist.push(e.mate > 0
        ? Math.min(15, 10 + 5 / Math.abs(e.mate))
        : Math.max(-15, -10 - 5 / Math.abs(e.mate)));
    } else {
      hist.push(Math.max(-10, Math.min(10, e.cp / 100)));
    }
  }
  return hist;
}

// --- Run all fixtures ---
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'lichess-accuracy-fixtures.json'), 'utf8'));
let failures = 0;
const errors = [];

for (const f of fixtures) {
  AppState.graphEvalHistory = toGraphHistory(f.evals);
  const res = calculateGameAccuracy();
  const dw = Math.abs(res.white - f.official.white);
  const db = Math.abs(res.black - f.official.black);
  errors.push(dw, db);
  const ok = dw <= TOLERANCE && db <= TOLERANCE;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${f.id}  official ${f.official.white}/${f.official.black}  app ${res.white}/${res.black}`);
}

const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
console.log(`\n${fixtures.length} games — mean abs error ${mean.toFixed(2)}, max ${Math.max(...errors).toFixed(1)} (tolerance ±${TOLERANCE})`);

if (failures) {
  console.error(`${failures} game(s) FAILED`);
  process.exit(1);
}
console.log('ALL GAMES MATCH lichess.org official accuracy.');
