// A topic: one of the places the winning chances go, opened from the report.
// The idea behind it, what it looks like in the player's games, the habit,
// puzzles (their own positions, and Lichess's on the same theme), and examples.
// Puzzles come before the examples: the examples show the answers.
import { h, bars, example, lessonCols, day, mmss, pct, cap, analysisLink } from './ui.js';
import { trainer, queue, due, learnt, lichessPuzzle } from './puzzle.js';

export function topic(data, key) {
  const scramble = key === 'scramble';
  const c = scramble ? data.scramble : data.causes.find(c => c.cause === key);
  if (!c) return null;
  const L = c.lesson;
  const facts = scramble
    ? `${c.moves} costly moves in ${c.games} games, made with ${c.seconds} seconds or less on the clock`
    : `${c.moves} costly moves in ${c.games} games · ${c.per_game} a game`;
  return h('article', { class: 'topic' },
    h('p', { class: 'back' }, h('a', { href: '#' }, '← The report')),
    h('header', { class: 'cause' }, h('div', { class: 'share' }, `${Math.round(c.share)}%`),
      h('div', {}, h('h1', {}, L.title), h('div', { class: 'facts' }, `${facts}. Of all the winning chances your ` +
        `mistakes gave away, ${Math.round(c.share)}% went this way.`))),
    h('h2', {}, 'The idea'),
    h('div', { class: 'card prose' }, L.concept.map(t => h('p', {}, t))),
    h('h2', {}, 'In your games'),
    h('div', { class: 'card' }, h('p', { class: 'what' }, L.what), L.why && h('p', { class: 'why' }, L.why),
      scramble ? clockPicture(data) : breakdown(c), lessonCols(L)),
    h('h2', {}, 'Puzzles'),
    h('p', { class: 'lede' }, scramble
      ? `Twenty seconds each, as in the game: positions from your games where one move clearly stood out, or a Lichess puzzle.`
      : `Positions from your games where one move clearly stood out, and puzzles from real games on Lichess on the same theme.`),
    puzzles(data, key, c),
    h('h2', {}, 'Examples from your games'),
    h('div', { class: 'examples' }, c.examples.map(example)));
}

// What the cause looked like: the tactics named, or for positional play the kinds, with advice
function breakdown(c) {
  if (c.features) return h('div', { class: 'breakdown' },
    bars(c.features.map(f => ({ label: cap(f.feature), value: f.share, tip: `${f.moves} moves` })), v => `${Math.round(v)}%`),
    c.features.filter(f => f.advice).map(f => h('p', {}, h('strong', {}, `${cap(f.feature)}. `), f.advice)));
  if (!c.detail.length) return null;
  return h('div', { class: 'breakdown' }, h('p', { class: 'muted' }, 'What it was, most often'),
    bars(c.detail.map(([k, n]) => ({ label: cap(k), value: n, tip: `${n} of ${c.moves} moves` })), v => `${v}`));
}

// The clock: blunders by seconds left in open positions, where the time goes, and what it costs in results
export function clockPicture(data) {
  const s = data.scramble, t = data.time, sp = t.median_spent;
  const where = t.clock_at_move.filter(([n]) => n <= 40).map(([n, sec]) => `${mmss(sec)} at move ${n}`);
  return h('div', {},
    h('p', { class: 'what' }, `You got down to ${s.seconds} seconds in ${s.reached} of ${data.games} games and scored ` +
      `${s.score_reached}% in them, against ${s.score_rest}% in the rest.`),
    h('div', { class: 'pair' },
      h('figure', {}, h('figcaption', {}, 'How often a move was a blunder, by time on the clock, in positions still open (20–80%)'),
        bars(Object.entries(t.by_clock).filter(([, v]) => v.moves).map(([name, v]) => ({
          label: cap(name), value: 100 * v.blunder_rate,
          tip: `${v.moves} moves · ${pct(v.costly_rate)} costly · accuracy ${v.accuracy}%`,
        })), v => `${v.toFixed(0)}%`)),
      h('figure', {}, h('figcaption', {}, `Where the time goes (${t.control.replace('+', ' + ')})`),
        h('p', {}, `Your clock, typically: ${where.join(', ')}.`),
        sp.opening != null && h('p', {}, `A move takes you ${sp.opening.toFixed(1)} s in the opening, ` +
          `${sp.middlegame.toFixed(1)} s in the middlegame and ${sp.endgame.toFixed(1)} s in the endgame (medians).`))));
}

// The player's own positions for this topic, or Lichess's, on one board
function puzzles(data, key, c) {
  const L = c.lesson, scramble = key === 'scramble';
  const own = data.positions.filter(p => scramble ? p.scramble && p.kind === 'find'
    : p.cause === key && !p.scramble && (p.kind === 'find' || L.refute));
  const task = p => key === 'missed_win' && p.punish ? 'Their last move was a mistake. Punish it.' : L.puzzle;
  const nextOwn = queue(own);
  const names = Object.fromEntries(L.drill.map(d => [d.url.split('/').pop(), d.name.toLowerCase()]));
  let source = own.length ? 'own' : 'lichess';
  const t = trainer({
    seconds: scramble ? 20 : null,
    next: async () => {
      if (source === 'own') { const p = nextOwn(); return p && ownPuzzle(p, task(p)); }
      const angle = L.angles[Math.floor(Math.random() * L.angles.length)];
      const z = await lichessPuzzle(angle);
      return { ...z, prompt: [`From a real game on Lichess, rated ${z.rating}. You're ${z.colour}. `,
        names[angle] ? `Theme: ${names[angle]}.` : 'Find the best move.'],
        after: () => [h('p', {}, h('a', { href: z.url, target: '_blank', rel: 'noopener' }, 'This puzzle on Lichess'))] };
    },
    status: () => source === 'own' ? `${due(own).length} due · ${learnt(own)} learnt · ${own.length} in all`
      : `Lichess: ${L.angles.map(a => names[a] ?? 'any theme').join(', ')}`,
  });
  const tabs = h('div', { class: 'tabs' }, [['own', `Your games (${own.length})`], ['lichess', 'Lichess']].map(([id, label]) =>
    h('button', { type: 'button', 'data-id': id, 'aria-pressed': String(source === id), onclick: e => {
      source = id;
      for (const b of tabs.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
      t.load();
    } }, label)));
  t.load();
  return h('div', {}, tabs, t.el);
}

// One of the player's positions as a puzzle: find their best move, or (refute)
// take the opponent's side and find the punishment for the move they played
export function ownPuzzle(p, task) {
  const when = `${day(p.date)}, vs ${p.opponent}, move ${p.move_no}. `;
  return {
    id: p.id, fen: p.fen, colour: p.colour, solution: [p.best], last: p.last,
    prompt: p.kind === 'refute'
      ? [when, 'You played ', h('strong', {}, p.played), `. Take your opponent's side (${p.colour}): find how to punish it.`]
      : [when, `You're ${p.colour}. In the game you played `, h('strong', {}, p.played), `. ${task}`],
    after: () => [
      p.line.length > 1 && h('p', {}, `The line: ${p.line.join(' ')}.`),
      h('p', {}, h('a', { href: analysisLink(p.url, p.kind === 'refute' ? p.ply : p.ply - 1, p.me), target: '_blank' },
        'Open in analysis'), ' · ', h('a', { href: p.url, target: '_blank', rel: 'noopener' }, 'chess.com')),
    ].filter(Boolean),
  };
}
