// Puzzles on chess2's board. The player's own positions have one clear answer
// (the best move beats every other by 10% of win chance or more); Lichess's
// come from real games with a verified line, the opponent's replies played for
// you. Own positions feed one spaced-repetition record, kept in this browser.
import { Board } from '../../chess2/js/board.js';
import { Chess } from '../../chess2/vendor/chess.js';
import { h, mmss } from './ui.js';

// ---- Spaced repetition: solved cleanly moves a position up a box, a miss sends it back ----
const DAYS = [0, 1, 3, 7, 21], KEY = 'coach.drills', DAY = 864e5;
let srs = {};
try { srs = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
function record(id, clean) {
  const box = clean ? Math.min((srs[id]?.box ?? 0) + 1, DAYS.length - 1) : 0;
  srs[id] = { box, due: Date.now() + (box ? DAYS[box] : 1) * DAY };
  try { localStorage.setItem(KEY, JSON.stringify(srs)); } catch {}
}
const isDue = p => !srs[p.id] || srs[p.id].due <= Date.now();
export const due = list => list.filter(isDue)
  .sort((a, b) => (srs[a.id]?.due ?? Infinity) - (srs[b.id]?.due ?? Infinity) || b.date - a.date);
export const learnt = list => list.filter(p => (srs[p.id]?.box ?? 0) >= 3).length;

// Due positions first, then the rest, round and round
export function queue(list) {
  let seen = new Set();
  return () => {
    if (!list.length) return null;
    if (seen.size >= list.length) seen = new Set();
    const p = [...due(list), ...list].find(p => !seen.has(p.id));
    seen.add(p.id);
    return p;
  };
}

// ---- Lichess: a random puzzle on a theme (its public API allows any origin) ----
export async function lichessPuzzle(angle) {
  const r = await fetch(`https://lichess.org/api/puzzle/next?angle=${encodeURIComponent(angle)}`,
    { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Lichess ${r.status}`);
  const { game, puzzle } = await r.json();
  const c = new Chess();
  let last = null;
  for (const san of game.pgn.split(' ')) { const m = c.move(san); last = m.from + m.to; }
  return { fen: c.fen(), colour: c.turn() === 'w' ? 'white' : 'black', solution: puzzle.solution, last,
    rating: puzzle.rating, url: `https://lichess.org/training/${puzzle.id}` };
}

const sans = (fen, ucis) => {
  const c = new Chess(fen);
  return ucis.map(u => c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
};
function checkSquare(c) {
  if (!c.inCheck()) return null;
  const turn = c.turn();
  for (const row of c.board()) for (const p of row) if (p?.type === 'k' && p.color === turn) return p.square;
  return null;
}

// The trainer. `next()` resolves to a puzzle, or null when there are none:
//   { id?, fen, colour, solution: [uci…], last?, prompt, after?(solved) → nodes }
// Moves alternate from the solver; any mating move counts, as on Lichess.
export function trainer({ next, status = () => '', seconds = null }) {
  const boardEl = h('div', { class: 'board' });
  const count = h('p', { class: 'count' }), prompt = h('p'), clock = h('p', { class: 'timer', hidden: true });
  const result = h('div', { class: 'result', 'aria-live': 'polite' });
  const el = h('div', { class: 'card practise' }, boardEl, h('div', { class: 'panel' }, count, prompt, clock, result,
    h('p', { class: 'buttons' }, h('button', { type: 'button', onclick: reveal }, 'Show answer'), ' ',
      h('button', { type: 'button', onclick: load }, 'Next'))));
  let pz = null, c = null, step = 0, missed = false, done = true, ticking = null, generation = 0;

  const board = new Board(boardEl, {
    dests: sq => pz && !done && c.turn() === pz.colour[0] ? c.moves({ square: sq, verbose: true }).map(m => m.to) : [],
    async onMove(from, to) {
      const promotes = c.get(from)?.type === 'p' && /[18]$/.test(to);
      const piece = promotes ? await board.promote(to, c.turn()) : '';
      if (piece === null) return draw();
      const move = c.move({ from, to, promotion: piece || undefined });
      if (from + to + (piece || '') !== pz.solution[step] && !c.isCheckmate()) {
        c.undo();
        missed = true;
        draw();
        return say('no', `Not ${move.san}. Try again, or show the answer.`);
      }
      step++;
      draw([from, to]);
      if (step >= pz.solution.length || c.isCheckmate()) return finish(true);
      say('ok', 'Yes. Keep going.');
      const reply = pz.solution[step++], mine = generation;
      setTimeout(() => {  // their reply, after a beat so the move reads
        if (mine !== generation) return;
        const m = c.move({ from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4] });
        draw([m.from, m.to]);
      }, 250);
    },
  });

  function draw(lastMove = null, arrows = []) {
    board.set({ fen: c.fen(), orientation: pz.colour, lastMove, check: checkSquare(c), arrows });
  }
  function say(cls, ...text) { result.replaceChildren(h('p', { class: cls }, ...text)); }
  function stop() { clearInterval(ticking); ticking = null; }

  function finish(solved) {
    done = true;
    stop();
    const clean = solved && !missed;
    if (pz.id) record(pz.id, clean);
    if (solved) say(clean ? 'ok' : 'no', clean ? 'Solved.' : 'Solved, at the second attempt.');
    else result.replaceChildren();
    result.append(...(pz.after?.(solved) ?? []));
    count.textContent = status();
  }

  function reveal() {
    if (done) return;
    missed = true;
    const rest = pz.solution.slice(step), u = rest[0];
    draw(null, [[u.slice(0, 2), u.slice(2, 4), 'best']]);
    finish(false);
    result.prepend(h('p', { class: 'no' }, `The answer: ${sans(c.fen(), rest).join(' ')}.`));
  }

  async function load() {
    const mine = ++generation;
    stop();
    done = true;
    result.replaceChildren();
    let p;
    try { p = await next(); } catch { return say('no', "Lichess didn't answer. Try again in a moment."); }
    if (mine !== generation) return;
    if (!p) {
      prompt.textContent = 'Nothing here yet. New positions arrive as new games are analysed.';
      return void (count.textContent = status());
    }
    pz = p; c = new Chess(p.fen); step = 0; missed = false; done = false;
    draw(p.last ? [p.last.slice(0, 2), p.last.slice(2, 4)] : null);
    prompt.replaceChildren(...[p.prompt].flat());
    result.replaceChildren();
    count.textContent = status();
    clock.hidden = !seconds;
    if (seconds) {
      const end = Date.now() + seconds * 1000;
      const tick = () => {
        if (!el.isConnected) return stop();  // the view was left: no result to record
        const left = Math.max(0, (end - Date.now()) / 1000);
        clock.textContent = mmss(Math.ceil(left));
        clock.classList.toggle('low', left <= 5);
        if (!left) { reveal(); result.prepend(h('p', { class: 'no' }, 'Out of time.')); }
      };
      tick();
      ticking = setInterval(tick, 200);
    }
  }

  return { el, load };
}
