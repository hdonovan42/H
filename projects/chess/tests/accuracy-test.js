// Accuracy Score Verification — 5 Sequential Bot Tests
// Compares OLD (simple average) vs NEW (Lichess volatility-weighted) formula
// All 5 bots must PASS for the implementation to be considered correct.

// === Shared formulas (copied from script.js) ===

const ACCURACY_COEFFICIENTS = { a: 103.1668, b: -0.04354, c: -3.1669 };

function evalToWinProbability(evalScore) {
  const cp = evalScore * 100;
  return (50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)) / 100;
}

// OLD: no +1 bonus
function cpLossToAccuracyOld(cpLoss) {
  const { a, b, c } = ACCURACY_COEFFICIENTS;
  const accuracy = a * Math.exp(b * cpLoss) + c;
  return Math.max(0, Math.min(100, accuracy));
}

// NEW: +1 uncertainty bonus (Lichess reference)
function cpLossToAccuracyNew(cpLoss) {
  const { a, b, c } = ACCURACY_COEFFICIENTS;
  const raw = a * Math.exp(b * cpLoss) + c;
  return Math.max(0, Math.min(100, raw + 1));
}

function calculateMoveAccuracy(evalBefore, evalAfter, isWhiteMove, cpLossToAccuracy) {
  const playerEvalBefore = isWhiteMove ? evalBefore : -evalBefore;
  const playerEvalAfter = isWhiteMove ? evalAfter : -evalAfter;
  const winProbBefore = evalToWinProbability(playerEvalBefore);
  const winProbAfter = evalToWinProbability(playerEvalAfter);
  const wpLoss = Math.max(0, winProbBefore - winProbAfter) * 100;
  return cpLossToAccuracy(wpLoss);
}

// OLD aggregation: simple arithmetic mean
function calculateGameAccuracyOld(evalHistory) {
  let wTotal = 0, wCount = 0, bTotal = 0, bCount = 0;
  for (let i = 1; i < evalHistory.length; i++) {
    if (evalHistory[i - 1] === undefined || evalHistory[i] === undefined) continue;
    const isWhite = (i % 2 === 1);
    const acc = calculateMoveAccuracy(evalHistory[i - 1], evalHistory[i], isWhite, cpLossToAccuracyOld);
    if (isWhite) { wTotal += acc; wCount++; }
    else { bTotal += acc; bCount++; }
  }
  return {
    white: wCount > 0 ? Math.round((wTotal / wCount) * 10) / 10 : null,
    black: bCount > 0 ? Math.round((bTotal / bCount) * 10) / 10 : null
  };
}

// NEW aggregation: Lichess volatility-weighted + harmonic mean
function computeWeightedAccuracy(winPcts, accuracies) {
  const n = accuracies.length;
  if (n === 0) return 0;
  const windowSize = Math.max(2, Math.min(8, Math.floor(n / 10)));
  if (n < windowSize) return accuracies.reduce((a, b) => a + b, 0) / n;

  let weightedSum = 0, weightTotal = 0, harmonicSum = 0, harmonicCount = 0;
  for (let start = 0; start <= n - windowSize; start++) {
    const windowWinPcts = winPcts.slice(start, start + windowSize);
    const mean = windowWinPcts.reduce((a, b) => a + b, 0) / windowSize;
    const variance = windowWinPcts.reduce((a, b) => a + (b - mean) ** 2, 0) / windowSize;
    const weight = Math.max(0.5, Math.min(12.0, Math.sqrt(variance)));

    const windowAccuracies = accuracies.slice(start, start + windowSize);
    const windowAvg = windowAccuracies.reduce((a, b) => a + b, 0) / windowSize;

    weightedSum += windowAvg * weight;
    weightTotal += weight;
    if (windowAvg > 0) { harmonicSum += 1 / windowAvg; harmonicCount++; }
  }

  const volatilityWeightedMean = weightedSum / weightTotal;
  const harmonicMean = harmonicCount > 0 ? harmonicCount / harmonicSum : volatilityWeightedMean;
  return (volatilityWeightedMean + harmonicMean) / 2;
}

function calculateGameAccuracyNew(evalHistory) {
  const whiteWinPcts = [], whiteAccuracies = [], blackWinPcts = [], blackAccuracies = [];
  for (let i = 1; i < evalHistory.length; i++) {
    if (evalHistory[i - 1] === undefined || evalHistory[i] === undefined) continue;
    const isWhite = (i % 2 === 1);
    const acc = calculateMoveAccuracy(evalHistory[i - 1], evalHistory[i], isWhite, cpLossToAccuracyNew);
    const playerEval = isWhite ? evalHistory[i - 1] : -evalHistory[i - 1];
    const winPct = evalToWinProbability(playerEval) * 100;
    if (isWhite) { whiteWinPcts.push(winPct); whiteAccuracies.push(acc); }
    else { blackWinPcts.push(winPct); blackAccuracies.push(acc); }
  }
  return {
    white: whiteAccuracies.length > 0
      ? Math.round(computeWeightedAccuracy(whiteWinPcts, whiteAccuracies) * 10) / 10 : null,
    black: blackAccuracies.length > 0
      ? Math.round(computeWeightedAccuracy(blackWinPcts, blackAccuracies) * 10) / 10 : null
  };
}

// === Test Runner ===

function runBot(name, evalHistory, expectedWhite, expectedBlack, tolerance = 5) {
  const oldResult = calculateGameAccuracyOld(evalHistory);
  const newResult = calculateGameAccuracyNew(evalHistory);

  const whiteInRange = newResult.white >= expectedWhite[0] && newResult.white <= expectedWhite[1];
  const blackInRange = newResult.black >= expectedBlack[0] && newResult.black <= expectedBlack[1];
  const pass = whiteInRange && blackInRange;

  console.log(`\n=== Bot ${name} ===`);
  console.log(`  OLD formula: white=${oldResult.white}%, black=${oldResult.black}%`);
  console.log(`  NEW formula: white=${newResult.white}%, black=${newResult.black}%`);
  console.log(`  Expected:    white=${expectedWhite[0]}-${expectedWhite[1]}%, black=${expectedBlack[0]}-${expectedBlack[1]}%`);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}`);

  if (!whiteInRange) console.log(`  >> White ${newResult.white}% outside expected range [${expectedWhite}]`);
  if (!blackInRange) console.log(`  >> Black ${newResult.black}% outside expected range [${expectedBlack}]`);

  return pass;
}

// === 5 Bot Tests ===

let allPass = true;
let passCount = 0;

// EVAL CONVENTION: All evals are from WHITE's perspective (positive = white better).
// White's moves are at ODD indices (1,3,5...). White blunders when eval DROPS.
// Black's moves are at EVEN indices (2,4,6...). Black blunders when eval RISES.

// Bot 1: Perfect Game — all evals stay constant at Cp(15)
// 20 half-moves, zero win probability lost by either side
const perfectEvals = [0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15,
                      0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15];
if (runBot('1: Perfect Game', perfectEvals, [99, 100], [99, 100])) passCount++;
else allPass = false;

// Bot 2: Average Club Game — white loses ~0.3-0.8 per move, black lets eval rise ~0.3-0.8
// Simulates ~1400 rated play: frequent small inaccuracies, occasional bigger mistake
const clubEvals = [0.15,
  -0.2,  // W move: dropped 0.35 (inaccuracy)
   0.3,  // B move: eval rose 0.5 (inaccuracy)
  -0.1,  // W move: dropped 0.4 (inaccuracy)
   0.6,  // B move: eval rose 0.7 (mistake)
   0.1,  // W move: dropped 0.5 (inaccuracy)
   0.8,  // B move: eval rose 0.7 (mistake)
   0.3,  // W move: dropped 0.5 (inaccuracy)
   0.9,  // B move: eval rose 0.6 (mistake)
   0.5,  // W move: dropped 0.4 (inaccuracy)
   1.2,  // B move: eval rose 0.7 (mistake)
   0.7,  // W move: dropped 0.5 (inaccuracy)
   1.5,  // B move: eval rose 0.8 (mistake)
   1.0,  // W move: dropped 0.5 (inaccuracy)
   1.8,  // B move: eval rose 0.8 (mistake)
   1.2,  // W move: dropped 0.6 (inaccuracy)
   2.0,  // B move: eval rose 0.8 (mistake)
   1.5,  // W move: dropped 0.5 (inaccuracy)
   2.3,  // B move: eval rose 0.8 (mistake)
   1.8,  // W move: dropped 0.5 (inaccuracy)
   2.5]; // B move: eval rose 0.7 (mistake)
if (runBot('2: Average Club Game', clubEvals, [55, 85], [55, 85])) passCount++;
else allPass = false;

// Bot 3: Blunder-fest — both sides drop 2-5 pawns per move, wild swings
const blunderEvals = [0.15,
  -2.0,  // W blunder: dropped 2.15
   2.0,  // B blunder: eval rose 4.0
  -1.5,  // W blunder: dropped 3.5
   3.0,  // B blunder: eval rose 4.5
  -2.5,  // W blunder: dropped 5.5
   4.0,  // B blunder: eval rose 6.5
  -3.0,  // W blunder: dropped 7.0
   5.0,  // B blunder: eval rose 8.0
  -2.0,  // W blunder: dropped 7.0
   4.0,  // B blunder: eval rose 6.0
  -3.0,  // W blunder: dropped 7.0
   5.0,  // B blunder: eval rose 8.0
  -2.5,  // W blunder: dropped 7.5
   6.0,  // B blunder: eval rose 8.5
  -1.0,  // W blunder: dropped 7.0
   3.0,  // B blunder: eval rose 4.0
  -2.0,  // W blunder: dropped 5.0
   5.0,  // B blunder: eval rose 7.0
  -3.0,  // W blunder: dropped 8.0
   4.0]; // B blunder: eval rose 7.0
if (runBot('3: Blunder-fest', blunderEvals, [5, 40], [5, 40])) passCount++;
else allPass = false;

// Bot 4: One-sided Crush — white plays accurately, black collapses early
// Black's big blunders happen in the opening/middlegame where WP changes are largest.
const crushEvals = [0.15,
   0.2,  // W: slight gain
   2.0,  // B blunder: +1.8 (huge when near equal — ~15% WP loss)
   2.2,  // W: slight gain
   4.0,  // B blunder: +1.8 (still meaningful — ~12% WP loss)
   4.2,  // W: slight gain
   6.0,  // B blunder: +1.8 (diminishing — ~6% WP loss)
   6.2,  // W: slight gain
   8.0,  // B blunder: +1.8 (tiny — ~2% WP loss, already lost)
   8.2,  // W: slight gain
  10.0,  // B blunder: +1.8 (negligible at this point)
  10.0,  // W: same
  10.0,  // B: same
  10.0,  // W: same
  10.0,  // B: same
  10.0,  // W: same
  10.0,  // B: same
  10.0,  // W: same
  10.0,  // B: same
  10.0,  // W: same
  10.0]; // B: same
if (runBot('4: One-sided Crush', crushEvals, [85, 100], [40, 80])) passCount++;
else allPass = false;

// Bot 5: Sharp Tactical — both sides play well, small eval changes
// Each move only drops eval ~0.05-0.15 for the mover (near-best play)
const sharpEvals = [0.15,
   0.10, // W: lost 0.05
   0.20, // B: eval rose 0.10
   0.10, // W: lost 0.10
   0.25, // B: eval rose 0.15
   0.15, // W: lost 0.10
   0.30, // B: eval rose 0.15
   0.20, // W: lost 0.10
   0.35, // B: eval rose 0.15
   0.25, // W: lost 0.10
   0.40, // B: eval rose 0.15
   0.30, // W: lost 0.10
   0.45, // B: eval rose 0.15
   0.35, // W: lost 0.10
   0.50, // B: eval rose 0.15
   0.40, // W: lost 0.10
   0.55, // B: eval rose 0.15
   0.45, // W: lost 0.10
   0.60, // B: eval rose 0.15
   0.50, // W: lost 0.10
   0.60];// B: eval rose 0.10
if (runBot('5: Sharp Tactical', sharpEvals, [85, 100], [85, 100])) passCount++;
else allPass = false;

// === Final Verdict ===
console.log(`\n${'='.repeat(40)}`);
console.log(`Result: ${passCount}/5 bots passed`);
if (allPass) {
  console.log('ALL 5 BOTS PASSED — accuracy formula is standardised.');
} else {
  console.log('SOME BOTS FAILED — review the ranges and formula.');
}
process.exit(allPass ? 0 : 1);
