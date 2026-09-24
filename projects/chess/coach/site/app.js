// The coach report: draws insights.json. Text from games (names, openings)
// only ever goes in as text; the example boards are chess2's own board.
import { Board } from '../../chess2/js/board.js';
import { Chess } from '../../chess2/vendor/chess.js';

const $ = sel => document.querySelector(sel);

// Element builder: strings become text nodes, never markup
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const day = t => new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const pct = x => `${Math.round(x * 100)}%`;
const RESULT = { win: 'Won', draw: 'Drew', loss: 'Lost' };
const SYMBOL = { inaccuracy: '?!', mistake: '?', blunder: '??' };
const analysisLink = (pgn, ply, colour) =>
  `../../analysis.html#${new URLSearchParams({ pgn, ply: String(ply), color: colour })}`;

// One shared tooltip; the hovered or focused element supplies [value, label]
const tipEl = $('#tip');
function tip(el, content) {
  const show = e => {
    const [value, label] = content();
    tipEl.replaceChildren(h('b', {}, value), label);
    tipEl.hidden = false;
    const r = e.clientX != null ? { x: e.clientX, y: e.clientY } : el.getBoundingClientRect();
    tipEl.style.left = `${Math.min(innerWidth - 290, (r.x ?? r.left) + 12)}px`;
    tipEl.style.top = `${(r.y ?? r.top) + 14}px`;
  };
  el.addEventListener('pointermove', show);
  el.addEventListener('focus', show);
  for (const ev of ['pointerleave', 'blur']) el.addEventListener(ev, () => { tipEl.hidden = true; });
}

const res = await fetch('insights.json', { cache: 'no-cache' }).catch(() => null);
if (!res?.ok) {
  $('main').replaceChildren(h('header', {}, h('h1', {}, 'Chess coach'),
    h('p', { class: 'sub' }, 'No report here yet. It is built by coach.py report (see the README).')));
  throw new Error('insights.json not found');
}
const data = await res.json();
const games = data.accuracy;

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

(function positional() {
  const p = data.causes.find(c => c.cause === 'positional');
  if (!p) return;
  $('#positional-lede').textContent = `${Math.round(p.share)}% of what your mistakes gave away had no tactic behind it: ` +
    `the position got worse without anything being lost at once. It isn't one habit, so here it is by kind.`;
  $('#positional').append(h('div', { class: 'card' },
    bars(p.features.map(f => ({ label: f.feature[0].toUpperCase() + f.feature.slice(1), value: f.share,
      tip: `${f.moves} moves` })), v => `${Math.round(v)}%`),
    h('div', { class: 'examples', style: 'margin-top:16px' }, p.features.slice(0, 3).map(f =>
      h('div', {}, h('h4', { class: 'feature' }, f.feature[0].toUpperCase() + f.feature.slice(1)),
        h('p', { class: 'why' }, f.advice), example(f.example))))));
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
    c.in_time_trouble >= 0.2 && `${pct(c.in_time_trouble)} in time trouble`,
  ].filter(Boolean).join(' · ');
  const detail = c.detail.slice(0, 4).map(([k, n]) => `${k} (${n})`).join(', ');
  return h('article', { class: 'card cause' },
    h('header', {}, h('div', { class: 'share' }, `${Math.round(c.share)}%`),
      h('div', {}, h('h3', {}, L.title), h('div', { class: 'facts' }, facts))),
    h('p', { class: 'what' }, L.what),
    h('p', { class: 'why' }, L.why, detail ? ` Most often: ${detail}.` : ''),
    h('div', { class: 'examples' }, c.examples.slice(0, 3).map(example)),
    h('div', { class: 'cols' },
      h('div', {}, h('h4', {}, 'The habit'), h('ol', {}, L.fix.map(f => h('li', {}, f)))),
      h('div', {}, h('h4', {}, 'Drill it'), h('ul', {},
        L.drill.map(d => h('li', {}, h('a', { href: d.url, target: '_blank', rel: 'noopener' }, `Lichess puzzles: ${d.name}`))),
        h('li', {}, 'Open each example below its board and find the better move before looking.')),
        h('p', { class: 'target' }, h('strong', {}, 'Target: '), L.target))));
}

function example(x) {
  const el = h('div', { class: 'board' });
  const card = h('div', { class: 'example' }, el,
    h('p', {}, `Move ${x.move_no} vs ${x.game.opponent.name}: you played `,
      h('strong', {}, x.san), badge(x), ` (−${Math.round(x.drop)}% win chance)`),
    h('p', {}, h('span', { class: 'key best' }), 'Better: ', h('strong', {}, x.best_line.slice(0, 3).join(' '))),
    x.reply_line.length ? h('p', { class: 'line' }, h('span', { class: 'key played' }),
      'After yours: ', x.reply_line.slice(0, 4).join(' ')) : null,
    h('p', {}, h('a', { href: analysisLink(x.game.pgn, x.ply - 1, x.colour), target: '_blank' }, 'Open in analysis'),
      ' · ', h('a', { href: x.game.url, target: '_blank', rel: 'noopener' }, 'chess.com'),
      ` · ${day(x.game.date)}`));
  const board = new Board(el, { dests: () => [], onMove() {} });
  board.set({ fen: x.fen, orientation: x.colour,
    arrows: [[x.best.slice(0, 2), x.best.slice(2, 4), 'best'], [x.uci.slice(0, 2), x.uci.slice(2, 4), 'played']] });
  return card;
}

function badge(x) {
  const j = x.drop >= 15 ? 'blunder' : x.drop >= 10 ? 'mistake' : 'inaccuracy';
  return h('span', { class: `badge ${j}` }, SYMBOL[j]);
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
      h('p', {}, h('a', { href: analysisLink(r.pgn, r.ply - 1, r.colour), target: '_blank' }, 'Open in analysis')));
    new Board(el, { dests: () => [], onMove() {} }).set({ fen: r.fen, orientation: r.colour,
      arrows: [[r.best.slice(0, 2), r.best.slice(2, 4), 'best'], [r.uci.slice(0, 2), r.uci.slice(2, 4), 'played']] });
    return card;
  })));
})();

// ---- Practice: the player's own positions, spaced repetition in this browser ----
(function practise() {
  const DAYS = [0, 1, 3, 7, 21], KEY = 'coach.drills', DAY = 864e5;
  let srs = {};
  try { srs = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(srs)); } catch {} };
  const due = () => data.puzzles.filter(p => !srs[p.id] || srs[p.id].due <= Date.now())
    .sort((a, b) => (srs[a.id]?.due ?? Infinity) - (srs[b.id]?.due ?? Infinity) || b.date - a.date);
  let current = null, missed = false;
  const board = new Board($('#drill'), {
    dests: sq => current && !current.done ? new Chess(current.fen).moves({ square: sq, verbose: true }).map(m => m.to) : [],
    async onMove(from, to) {
      const c = new Chess(current.fen);
      const promotes = c.get(from)?.type === 'p' && /[18]$/.test(to);
      const piece = promotes ? await board.promote(to, c.turn()) : '';
      if (piece === null) return show();
      const move = c.move({ from, to, promotion: piece || undefined });
      if (from + to + (piece || '') === current.best) {
        board.set({ fen: c.fen(), orientation: current.colour, lastMove: [from, to] });
        finish(true, `Yes: ${move.san}. ${lineText()}`);
      } else {
        missed = true;
        show();
        result('no', `Not ${move.san}. Try again, or show the answer.`);
      }
    },
  });
  const lineText = () => current.line.length > 1 ? `The line: ${current.line.join(' ')}.` : '';
  const result = (cls, text) => $('#drill-result').replaceChildren(h('span', { class: cls }, text));
  function show() {
    board.set({ fen: current.fen, orientation: current.colour,
      arrows: current.done ? [[current.best.slice(0, 2), current.best.slice(2, 4), 'best']] : [] });
  }
  function finish(solved, text) {
    current.done = true;
    const box = solved && !missed ? Math.min((srs[current.id]?.box ?? 0) + 1, DAYS.length - 1) : 0;
    srs[current.id] = { box, due: Date.now() + (box ? DAYS[box] : 1) * DAY };
    save();
    result(solved && !missed ? 'ok' : 'no', text);
    count();
  }
  function count() {
    const learnt = data.puzzles.filter(p => (srs[p.id]?.box ?? 0) >= 3).length;
    $('#drill-count').textContent = `${due().length} due · ${learnt} learnt · ${data.puzzles.length} in all`;
  }
  function next() {
    current = due()[0] ? { ...due()[0] } : null;
    missed = false;
    $('#drill-result').replaceChildren();
    if (!current) {
      $('#drill-prompt').textContent = 'Nothing due. New positions arrive as new games are analysed.';
      return count();
    }
    $('#drill-prompt').replaceChildren(`${day(current.date)}, vs ${current.opponent}, move ${current.move_no}. You're `,
      h('strong', {}, current.colour), `. In the game you played ${current.played}. Find the move that stood out.`);
    show();
    count();
  }
  $('#drill-show').addEventListener('click', () => {
    if (!current || current.done) return;
    missed = true;
    finish(false, `The move: ${current.line[0]}. ${lineText()}`);
    show();
  });
  $('#drill-next').addEventListener('click', next);
  next();
})();

// ---- Bars: causes, phases, clock ----
function bars(rows, fmt) {
  const max = Math.max(...rows.map(r => r.value), 1e-9);
  return h('div', { class: 'bars' }, rows.flatMap(r => {
    const bar = h('div', { class: 'bar', tabindex: 0, style: `width:${(90 * r.value) / max}%` });
    tip(bar, () => [fmt(r.value), r.tip]);
    const track = h('div', { class: 'track' }, bar,
      h('span', { class: 'val', style: `left:calc(${(90 * r.value) / max}% + 6px)` }, fmt(r.value)));
    return [h('div', {}, r.label), track];
  }));
}

$('#causes').append(bars(data.causes.map(c => ({
  label: c.lesson.title, value: c.share,
  tip: `${c.moves} moves in ${c.games} games · ${c.per_game} a game`,
})), v => `${v.toFixed(1)}%`));

const phaseTotal = Object.values(data.phases).reduce((s, p) => s + p.cost, 0) || 1;
$('#phases').append(h('p', { class: 'muted' }, 'Share of all win chance given away, by phase'), bars(
  Object.entries(data.phases).map(([p, v]) => ({
    label: p[0].toUpperCase() + p.slice(1), value: 100 * v.cost / phaseTotal,
    tip: `${v.costly} costly moves out of ${v.moves}`,
  })), v => `${Math.round(v)}%`));

$('#clock').append(h('p', { class: 'muted', style: 'margin-top:16px' }, 'How often a move was costly, by time left'), bars(
  Object.entries(data.time.by_clock).filter(([, v]) => v.moves).map(([name, v]) => ({
    label: name[0].toUpperCase() + name.slice(1), value: 100 * v.costly_rate, tip: `${v.moves} moves`,
  })), v => `${v.toFixed(0)}%`));

// ---- Accuracy over time: each game in grey, a 15-game average in the accent ----
(function accuracyChart() {
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
        h('td', {}, h('a', { href: analysisLink(g.pgn, g.peak_ply, g.colour), target: '_blank' }, 'Open'))))) : null,
    h('div', { class: 'cols' },
      h('div', {}, h('h4', {}, 'The habit'), h('ol', {}, L.fix.map(f => h('li', {}, f)))),
      h('div', {}, h('h4', {}, 'Drill it'), h('ul', {}, L.drill.map(d =>
        h('li', {}, h('a', { href: d.url, target: '_blank', rel: 'noopener' }, `Lichess puzzles: ${d.name}`))))))));
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
    h('td', {}, h('a', { href: analysisLink(g.pgn, 0, g.colour), target: '_blank' }, 'Analyse'), ' · ',
      h('a', { href: g.url, target: '_blank', rel: 'noopener' }, 'chess.com'))))));
$('#method').textContent = `Computer analysis: Stockfish 19, one million nodes per position, the same on any machine. ` +
  `Accuracy and move judgements follow Lichess's published formulas exactly. Built ${data.generated.replace('T', ' ')} UTC.`;
