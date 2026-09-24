// What the coach's views share: an element builder, formats, the tooltip, bar
// charts and example boards. Text from games (names, openings) only ever goes
// in as text; the boards are chess2's own.
import { Board } from '../../chess2/js/board.js';

export const $ = sel => document.querySelector(sel);

// Element builder: strings become text nodes, never markup
export function h(tag, attrs = {}, ...kids) {
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
export const svg = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

export const day = t => new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
export const pct = x => `${Math.round(x * 100)}%`;
export const mmss = sec => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
export const cap = s => s[0].toUpperCase() + s.slice(1);
export const RESULT = { win: 'Won', draw: 'Drew', loss: 'Lost' };
const SYMBOL = { inaccuracy: '?!', mistake: '?', blunder: '??' };

// Every game's PGN travels once, in the report's game list; the rest refer to it by URL
const pgns = new Map();
export const setGames = list => { for (const g of list) pgns.set(g.url, g.pgn); };
export const analysisLink = (url, ply, colour) =>
  `../../analysis.html#${new URLSearchParams({ pgn: pgns.get(url) ?? '', ply: String(ply), color: colour })}`;

// One shared tooltip; the hovered or focused element supplies [value, label]
export function tip(el, content) {
  const tipEl = $('#tip');
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

// Horizontal bars; a row with an href is a link (label and bar alike)
export function bars(rows, fmt) {
  const max = Math.max(...rows.map(r => r.value), 1e-9);
  return h('div', { class: 'bars' }, rows.flatMap(r => {
    const bar = h('div', { class: 'bar', tabindex: r.href ? -1 : 0, style: `width:${(90 * r.value) / max}%` });
    tip(bar, () => [fmt(r.value), r.tip]);
    const track = h('div', { class: 'track' }, bar,
      h('span', { class: 'val', style: `left:calc(${(90 * r.value) / max}% + 6px)` }, fmt(r.value)));
    if (!r.href) return [h('div', {}, r.label), track];
    track.classList.add('link');
    track.addEventListener('click', () => { location.hash = r.href; });
    return [h('a', { href: r.href }, r.label), track];
  }));
}

// A costly move from the player's games: the position, the better move (green)
// and the move played (red)
export function example(x) {
  const el = h('div', { class: 'board' });
  const card = h('div', { class: 'example' }, el,
    h('p', {}, `Move ${x.move_no} vs ${x.game.opponent.name}: you played `,
      h('strong', {}, x.san), badge(x), ` (−${Math.round(x.drop)}% win chance` +
      (x.clock != null ? `, ${mmss(x.clock)} on the clock)` : ')')),
    h('p', {}, h('span', { class: 'key best' }), 'Better: ', h('strong', {}, x.best_line.slice(0, 3).join(' '))),
    x.reply_line.length ? h('p', { class: 'line' }, h('span', { class: 'key played' }),
      'After yours: ', x.reply_line.slice(0, 4).join(' ')) : null,
    h('p', {}, h('a', { href: analysisLink(x.game.url, x.ply - 1, x.colour), target: '_blank' }, 'Open in analysis'),
      ' · ', h('a', { href: x.game.url, target: '_blank', rel: 'noopener' }, 'chess.com'),
      ` · ${day(x.game.date)}`));
  new Board(el, { dests: () => [], onMove() {} }).set({ fen: x.fen, orientation: x.colour,
    arrows: [[x.best.slice(0, 2), x.best.slice(2, 4), 'best'], [x.uci.slice(0, 2), x.uci.slice(2, 4), 'played']] });
  return card;
}

export function badge(x) {
  const j = x.drop >= 15 ? 'blunder' : x.drop >= 10 ? 'mistake' : 'inaccuracy';
  return h('span', { class: `badge ${j}` }, SYMBOL[j]);
}

// A lesson's habit and drills, side by side
export function lessonCols(L, extra = []) {
  return h('div', { class: 'cols' },
    h('div', {}, h('h4', {}, 'The habit'), h('ol', {}, L.fix.map(f => h('li', {}, f)))),
    h('div', {}, h('h4', {}, 'Drill it'), h('ul', {},
      L.drill.map(d => h('li', {}, h('a', { href: d.url, target: '_blank', rel: 'noopener' }, `Lichess puzzles: ${d.name}`))),
      extra.map(x => h('li', {}, x))),
      L.target && h('p', { class: 'target' }, h('strong', {}, 'Target: '), L.target)));
}
