// The coach report: draws insights.json. Each place the winning chances go
// opens as a topic of its own (#topic=<cause>): the idea, examples, puzzles.
import { Board } from '../../chess2/js/board.js';
import { $, h, svg, day, pct, cap, RESULT, analysisLink, setGames, bars, example, lessonCols } from './ui.js';
import { trainer, due, learnt } from './puzzle.js';
import { topic, clockPicture, ownPuzzle } from './topic.js';

const res = await fetch('insights.json', { cache: 'no-cache' }).catch(() => null);
if (!res?.ok) {
  $('main').replaceChildren(h('header', {}, h('h1', {}, 'Chess coach'),
    h('p', { class: 'sub' }, 'No report here yet. It is built by coach.py report (see the README).')));
  throw new Error('insights.json not found');
}
const data = await res.json();
const games = data.accuracy;
setGames(data.list);
const more = key => h('p', { class: 'more' }, h('a', { href: `#topic=${key}` }, 'The idea, more examples, and puzzles →'));

// ---- Header and stat tiles ----
$('#sub').textContent = `${data.player} · ${data.games} games, ${day(data.period[0])} – ${day(data.period[1])} · ` +
  `Stockfish 19 on every move`;
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const accs = games.filter(g => g.a != null);
const half = Math.floor(accs.length / 2);
const [early, late] = [mean(accs.slice(0, half).map(g => g.a)), mean(accs.slice(half).map(g => g.a))];
const r = data.record;
$('#kpis').append(
  kpi('Games', data.games, `${r.win} won · ${r.draw} drawn · ${r.loss} lost`),
  kpi('Average accuracy', `${mean(accs.map(g => g.a)).toFixed(1)}%`,
    `${late >= early ? '▲' : '▼'} ${Math.abs(late - early).toFixed(1)} from the first half to the second`),
  kpi('Costly moves a game', (data.costly / data.games).toFixed(1), 'mistakes and blunders'),
  kpi('Opponent blunders punished', data.punish.rate == null ? '–' : pct(data.punish.rate),
    `${data.punish.punished} of ${data.punish.chances}`),
);
function kpi(label, value, delta) {
  return h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value),
    h('div', { class: 'delta' }, delta));
}

// ---- The top three causes: the concrete ones (positional mistakes get their own section) ----
for (const c of data.causes.filter(c => c.cause !== 'positional').slice(0, 3)) $('#top').append(causeCard(c));

// ---- Short of time: scramble moves, kept apart from the habits above ----
(function scramble() {
  const s = data.scramble, t = data.time, L = s.lesson;
  $('#top-lede').textContent = `Ranked by how much of the winning chances your mistakes gave away, counting moves made with ` +
    `more than ${s.seconds} seconds on the clock. Every example is from your own games.`;
  $('#scramble-lede').textContent = `Moves made with ${s.seconds} seconds or less are counted here, not above.`;
  $('#scramble').append(h('article', { class: 'card cause' },
    h('header', {}, h('div', { class: 'share' }, `${Math.round(s.share)}%`),
      h('div', {}, h('h3', {}, L.title), h('div', { class: 'facts' }, `${s.moves} costly moves in ${s.games} games` +
        (t.lost_on_time ? ` · ${t.lost_on_time} games lost on time` : '')))),
    h('p', { class: 'why' }, L.what),
    clockPicture(data),
    h('div', { class: 'examples' }, s.examples.slice(0, 3).map(example)),
    lessonCols(L), more('scramble')));
})();

(function positional() {
  const p = data.causes.find(c => c.cause === 'positional');
  if (!p) return;
  $('#positional-lede').textContent = `${Math.round(p.share)}% of what your mistakes gave away had no tactic behind it: ` +
    `the position got worse without anything being lost at once. It isn't one habit, so here it is by kind.`;
  $('#positional').append(h('div', { class: 'card' },
    bars(p.features.map(f => ({ label: cap(f.feature), value: f.share,
      tip: `${f.moves} moves` })), v => `${Math.round(v)}%`),
    h('div', { class: 'examples', style: 'margin-top:16px' }, p.features.slice(0, 3).map(f =>
      h('div', {}, h('h4', { class: 'feature' }, cap(f.feature)),
        h('p', { class: 'why' }, f.advice), example(f.example)))), more('positional')));
})();

function causeCard(c) {
  const L = c.lesson;
  const [a, b] = c.trend;
  const trend = a === 0 ? '' : b < a * 0.85 ? 'improving' : b > a * 1.15 ? 'getting worse' : 'holding steady';
  const facts = [
    `${c.moves} moves in ${c.games} games`,
    trend && `${trend} over the period`,
    c.after_opponent_error >= 0.3 && `${pct(c.after_opponent_error)} came straight after your opponent's mistake`,
    c.fast >= 0.2 && `${pct(c.fast)} played in under 2 seconds`,
  ].filter(Boolean).join(' · ');
  const detail = c.detail.slice(0, 4).map(([k, n]) => `${k} (${n})`).join(', ');
  return h('article', { class: 'card cause' },
    h('header', {}, h('div', { class: 'share' }, `${Math.round(c.share)}%`),
      h('div', {}, h('h3', {}, L.title), h('div', { class: 'facts' }, facts))),
    h('p', { class: 'what' }, L.what),
    h('p', { class: 'why' }, L.why, detail ? ` Most often: ${detail}.` : ''),
    h('div', { class: 'examples' }, c.examples.slice(0, 3).map(example)),
    lessonCols(L), more(c.cause));
}

// ---- Repeated mistakes ----
(function repeats() {
  const list = data.repeats.slice(0, 6);
  if (!list.length) return $('#repeats').append(h('p', { class: 'card muted' }, 'None yet: no costly move has been repeated from the same position.'));
  $('#repeats').append(h('div', { class: 'examples' }, list.map(r => {
    const el = h('div', { class: 'board' });
    const card = h('div', { class: 'example card' }, el,
      h('p', {}, `Move ${(r.ply + 1) >> 1}: you played `, h('strong', {}, r.san), ` in ${r.times} games (−${Math.round(r.drop)}% each time)`),
      h('p', {}, h('span', { class: 'key best' }), 'Better: ', h('strong', {}, r.best_line.slice(0, 3).join(' '))),
      h('p', { class: 'line' }, `Against ${r.opponents.join(', ')}`),
      h('p', {}, h('a', { href: analysisLink(r.url, r.ply - 1, r.colour), target: '_blank' }, 'Open in analysis')));
    new Board(el, { dests: () => [], onMove() {} }).set({ fen: r.fen, orientation: r.colour,
      arrows: [[r.best.slice(0, 2), r.best.slice(2, 4), 'best'], [r.uci.slice(0, 2), r.uci.slice(2, 4), 'played']] });
    return card;
  })));
})();

// ---- Practice: the positions where one move stood out, spaced repetition in this browser ----
(function practise() {
  const drills = data.positions.filter(p => p.only && p.kind === 'find');
  const t = trainer({
    next: () => { const p = due(drills)[0]; return p ? ownPuzzle(p, 'Find the move that stood out.') : null; },
    status: () => `${due(drills).length} due · ${learnt(drills)} learnt · ${drills.length} in all`,
  });
  $('#practise').append(t.el);
  t.load();
})();

// ---- Where the winning chances go: by cause (each opens its topic) and by phase ----
$('#causes').append(bars([...data.causes.map(c => ({
  label: c.lesson.title, value: c.share, href: `#topic=${c.cause}`,
  tip: `${c.moves} moves in ${c.games} games · ${c.per_game} a game`,
})), { label: data.scramble.lesson.title, value: data.scramble.share, href: '#topic=scramble',
  tip: `${data.scramble.moves} moves with ${data.scramble.seconds} s or less on the clock` }].sort((a, b) => b.value - a.value),
v => `${v.toFixed(1)}%`));

const phaseTotal = Object.values(data.phases).reduce((s, p) => s + p.cost, 0) || 1;
$('#phases').append(h('p', { class: 'muted' }, 'Share of all win chance given away, by phase'), bars(
  Object.entries(data.phases).map(([p, v]) => ({
    label: cap(p), value: 100 * v.cost / phaseTotal,
    tip: `${v.costly} costly moves out of ${v.moves}`,
  })), v => `${Math.round(v)}%`));

// ---- Accuracy over time: each game in grey, a 15-game average in the accent ----
(function accuracyChart() {
  const tipEl = $('#tip');
  const W = 960, H = 240, L = 34, R = 8, T = 8, B = 22;
  const n = accs.length, x = i => L + (W - L - R) * (n > 1 ? i / (n - 1) : 0.5), y = a => T + (H - T - B) * (1 - a / 100);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Accuracy per game, with a 15-game average' });
  for (const v of [25, 50, 75, 100]) {
    root.append(svg('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    const t = svg('text', { class: 'axis', x: L - 6, y: y(v) + 4, 'text-anchor': 'end' });
    t.textContent = v;
    root.append(t);
  }
  accs.forEach((g, i) => root.append(svg('circle', { class: 'dot', cx: x(i), cy: y(g.a), r: 3 })));
  const avg = accs.map((_, i) => mean(accs.slice(Math.max(0, i - 14), i + 1).map(g => g.a)));
  root.append(svg('path', { class: 'trend', d: avg.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('') }));
  const cross = svg('line', { class: 'cross', y1: T, y2: H - B, visibility: 'hidden' });
  const hot = svg('circle', { class: 'hot', r: 5, visibility: 'hidden' });
  root.append(cross, hot);
  root.addEventListener('pointermove', e => {
    const b = root.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - b.left) / b.width * W - L) / (W - L - R) * (n - 1))));
    const g = accs[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    hot.setAttribute('cx', x(i)); hot.setAttribute('cy', y(g.a)); hot.setAttribute('visibility', 'visible');
    tipEl.replaceChildren(h('b', {}, `${g.a.toFixed(1)}%`), `${RESULT[g.r]} · ${g.tc} · ${day(g.t)} · average ${avg[i].toFixed(1)}%`);
    tipEl.hidden = false;
    tipEl.style.left = `${Math.min(innerWidth - 290, e.clientX + 12)}px`;
    tipEl.style.top = `${e.clientY + 14}px`;
  });
  root.addEventListener('pointerleave', () => { tipEl.hidden = true; cross.setAttribute('visibility', 'hidden'); hot.setAttribute('visibility', 'hidden'); });
  for (const [i, anchor] of [[0, 'start'], [n - 1, 'end']]) {  // the period, at each end of the x-axis
    const t = svg('text', { class: 'axis', x: x(i), y: H - 4, 'text-anchor': anchor });
    t.textContent = day(accs[i].t);
    root.append(t);
  }
  $('#accuracy').append(root);
  $('#acc-cap').textContent = `Lichess-method accuracy for each of ${n} games (grey), and the average of the last 15 (blue)`;
})();

// ---- Winning positions not won ----
(function conversion() {
  const c = data.conversion, L = c.lesson;
  const list = c.games.sort((a, b) => b.date - a.date);
  $('#conversion').append(h('div', { class: 'card' },
    h('p', { class: 'what' }, `${list.length} game${list.length === 1 ? '' : 's'} where you stood 90% or better and didn't win.`),
    list.length ? h('table', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Opponent'), h('th', {}, 'Game'),
      h('th', { class: 'num' }, 'Best'), h('th', {}, 'Result'), h('th', {})),
      list.map(g => h('tr', {}, h('td', {}, day(g.date)), h('td', {}, g.opponent.name), h('td', {}, g.time_class),
        h('td', { class: 'num' }, `${Math.round(g.peak)}%`), h('td', {}, `${RESULT[g.result]} (${g.how})`),
        h('td', {}, h('a', { href: analysisLink(g.url, g.peak_ply, g.colour), target: '_blank' }, 'Open'))))) : null,
    lessonCols(L)));
})();

// ---- Openings ----
(function openings() {
  const rows = data.openings.filter(o => o.games >= 2);
  $('#openings').append(h('div', { class: 'card' },
    h('p', { class: 'muted' }, 'Openings you played at least twice. "Given away" is the average win chance lost per game while still in the opening.'),
    h('table', {}, h('tr', {}, h('th', {}, 'As'), h('th', {}, 'Opening'), h('th', { class: 'num' }, 'Games'),
      h('th', { class: 'num' }, 'Score'), h('th', { class: 'num' }, 'Accuracy'), h('th', { class: 'num' }, 'Given away')),
      rows.map(o => h('tr', {}, h('td', {}, o.colour), h('td', {}, o.opening), h('td', { class: 'num' }, o.games),
        h('td', { class: 'num' }, `${o.score}%`), h('td', { class: 'num' }, o.accuracy == null ? '–' : `${o.accuracy}%`),
        h('td', { class: 'num' }, `${Math.round(o.opening_cost * 100)}%`))))));
})();

// ---- All games: the table view behind the accuracy chart ----
$('#games-sum').textContent = `Every game (${data.games}), newest first`;
$('#games').append(h('table', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'As'), h('th', {}, 'Opponent'),
  h('th', {}, 'Game'), h('th', {}, 'Result'), h('th', { class: 'num' }, 'Accuracy'), h('th', {})),
  data.list.map(g => h('tr', {}, h('td', {}, day(g.t)), h('td', {}, g.colour), h('td', {}, `${g.opponent.name} (${g.opponent.rating})`),
    h('td', {}, g.tc), h('td', {}, `${RESULT[g.result]} (${g.how})`), h('td', { class: 'num' }, g.accuracy == null ? '–' : `${g.accuracy}%`),
    h('td', {}, h('a', { href: analysisLink(g.url, 0, g.colour), target: '_blank' }, 'Analyse'), ' · ',
      h('a', { href: g.url, target: '_blank', rel: 'noopener' }, 'chess.com'))))));
$('#method').textContent = `Computer analysis: Stockfish 19, one million nodes per position, the same on any machine. ` +
  `Accuracy and move judgements follow Lichess's published formulas exactly. Built ${data.generated.replace('T', ' ')} UTC.`;

// ---- Topics: #topic=<cause> swaps the report for that topic, and back ----
let reportScroll = 0;
function route() {
  const key = new URLSearchParams(location.hash.slice(1)).get('topic');
  const view = key && topic(data, key);
  if (view && !$('#report').hidden) reportScroll = scrollY;
  $('#topic').replaceChildren(...(view ? [view] : []));
  $('#topic').hidden = !view;
  $('#report').hidden = !!view;
  scrollTo(0, view ? 0 : reportScroll);
}
addEventListener('hashchange', route);
route();
