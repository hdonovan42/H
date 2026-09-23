// Lichess's game-analysis maths, ported line for line from lila so the numbers
// match lichess.org: accuracy (AccuracyPercent.scala) and move judgements
// (Advice.scala). Pure functions, no DOM — tests/lichess.test.js checks both
// against lichess.org's own analysis of real games.
//
// An eval is { cp } or { mate } from White's point of view; mate is never 0
// (a checkmated position has no eval, exactly as in lila).

const CEILING = 1000;             // Cp.CEILING
export const INITIAL = { cp: 15 };  // Cp.initial: the start position's eval

// Mates count as the ceiling (lila's forceAsCp followed by the cap)
const cpOf = e => e.mate !== undefined ? (e.mate > 0 ? CEILING : -CEILING) : e.cp;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// [-1, 1]; lila deliberately leaves cp uncapped here (Advice uses it raw)
const winningChances = cp => clamp(2 / (1 + Math.exp(-0.00368208 * cp)) - 1, -1, 1);

// [0, 100], White's point of view (WinPercent.fromCentiPawns caps first)
export const winPercent = e => 50 + 50 * winningChances(clamp(cpOf(e), -CEILING, CEILING));

function moveAccuracy(before, after) {
  if (after >= before) return 100;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * (before - after)) - 3.166924740191411;
  return clamp(raw + 1, 0, 100);  // +1: uncertainty bonus for imperfect analysis
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };

// Game accuracy per colour from the evals after each move (not the start
// position). Mean of a volatility-weighted mean and a harmonic mean of the
// per-move accuracies. Returns { white, black } unrounded; null if no moves.
export function accuracy(evals, whiteStarts = true) {
  const wins = [INITIAL, ...evals].map(winPercent);
  const size = clamp(Math.floor(evals.length / 10), 2, 8);
  const windows = [];
  for (let i = 0; i < Math.min(size, wins.length) - 2; i++) windows.push(wins.slice(0, size));
  for (let i = 0; i + size <= wins.length; i++) windows.push(wins.slice(i, i + size));
  if (wins.length < size) windows.push(wins);  // Scala's sliding on a short list
  const weights = windows.map(w => clamp(stdev(w), 0.5, 12));

  const by = { white: [], black: [] };
  for (let i = 0; i < wins.length - 1 && i < weights.length; i++) {
    const white = (i % 2 === 0) === whiteStarts;
    const [prev, next] = [wins[i], wins[i + 1]];
    by[white ? 'white' : 'black'].push([white ? moveAccuracy(prev, next) : moveAccuracy(next, prev), weights[i]]);
  }
  const colour = moves => {
    if (!moves.length) return null;
    const weighted = moves.reduce((s, [a, w]) => s + a * w, 0) / moves.reduce((s, [, w]) => s + w, 0);
    const harmonic = moves.length / moves.reduce((s, [a]) => s + 1 / Math.max(1, a), 0);
    return (weighted + harmonic) / 2;
  };
  return evals.length ? { white: colour(by.white), black: colour(by.black) } : null;
}

// Judgement of one move from the evals before and after it, or null. lila only
// asks when the move differs from the engine's best — the caller checks that.
export function judge(prev, next, whiteMoved) {
  const pov = whiteMoved ? 1 : -1;
  if (prev.cp !== undefined && next.cp !== undefined) {
    const drop = (winningChances(prev.cp) - winningChances(next.cp)) * pov;
    return drop >= 0.3 ? 'blunder' : drop >= 0.2 ? 'mistake' : drop >= 0.1 ? 'inaccuracy' : null;
  }
  // Mate sequences, from the mover's point of view
  const pm = prev.mate !== undefined ? prev.mate * pov : undefined;
  const nm = next.mate !== undefined ? next.mate * pov : undefined;
  if (pm === undefined && nm < 0) {         // walked into a forced mate
    const cp = prev.cp * pov;
    return cp < -999 ? 'inaccuracy' : cp < -700 ? 'mistake' : 'blunder';
  }
  if (pm > 0 && (nm === undefined || nm < 0)) {  // let a forced mate slip
    const cp = nm === undefined ? next.cp * pov : 0;
    return cp > 999 ? 'inaccuracy' : cp > 700 ? 'mistake' : 'blunder';
  }
  return null;
}
