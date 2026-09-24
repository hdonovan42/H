// chess2: an analysis board. Holds the move tree, runs Stockfish on the board
// position and over a loaded game, and draws everything from `state`.

import { Chess, validateFen } from '../vendor/chess.js';
import { Engine } from './engine.js';
import { Board } from './board.js';
import { Graph } from './graph.js';
import { accuracy, judge, winPercent, INITIAL } from './lichess.js';

const $ = sel => document.querySelector(sel);
const START = new Chess().fen();

// ---- Stockfish 19 --------------------------------------------------------------
// Threads need SharedArrayBuffer, which needs cross-origin isolation (supplied on
// GitHub Pages by coi-serviceworker). Without it the small single-threaded build
// does everything.
const THREADED = self.crossOriginIsolated === true;
const THREADS = THREADED ? Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 2) - 1)) : 1;
const sf = file => new URL(`../vendor/stockfish/${file}`, import.meta.url);
const LITE = sf(THREADED ? 'stockfish-19-lite.js' : 'stockfish-19-lite-single.js');  // 1.6 MB: arrows in a second
const FULL = THREADED ? sf('stockfish-19.js') : LITE;                                  // 94 MB: full strength
const LIVE = 'depth 99 movetime 10000';  // the board position: up to 10 s
const SKETCH = 'nodes 20000';            // review pass 1: the whole curve in about a second
const DEEP = 'nodes 600000';             // review pass 2: the evals that count

const spawn = (url, multipv) => new Engine(url, { Threads: THREADS, Hash: 64, MultiPV: multipv });

// ---- State -----------------------------------------------------------------
// A node is a position: { id, parent, children, fen, ply, san, uci } plus, for a
// reviewed game, { eval, best, pv, pass }. children[0] continues the main line.
const state = { root: null, node: null, game: null, headers: {}, orientation: 'white', engineOn: true };
const nodes = new Map();  // id → node
const seen = new Map();   // fen → deepest search of that position on the board
let nextId = 0;

function addNode(parent, fen, move) {
  const [, turn, , , , fullmove] = fen.split(' ');
  const n = { id: nextId++, parent, children: [], fen, san: move?.san, uci: move?.lan,
    ply: parent ? parent.ply + 1 : 2 * (fullmove - 1) + (turn === 'b') };
  nodes.set(n.id, n);
  parent?.children.push(n);
  return n;
}

const mainline = n => { const line = [n]; while (n.children[0]) line.push(n = n.children[0]); return line; };
const onMainline = n => !n.parent || (n.parent.children[0] === n && onMainline(n.parent));
const whiteMoved = n => n.ply % 2 === 1;

// Rules facts about a position, worked out once
function facts(n) {
  if (!n.facts) {
    const c = new Chess(n.fen);
    n.facts = {
      turn: c.turn(),
      check: c.inCheck() ? c.findPiece({ type: 'k', color: c.turn() })[0] : null,
      over: c.isCheckmate() ? 'checkmate' : c.isStalemate() ? 'stalemate' : null,
    };
  }
  return n.facts;
}

// lila judges a move only when it wasn't the engine's choice
function judgement(n) {
  const p = n.parent;
  if (!p?.best || p.best === n.uci || !n.eval || !(p.eval || p === state.root)) return null;
  return judge(p === state.root ? INITIAL : p.eval, n.eval, whiteMoved(n));
}

function accuracies() {
  const moves = state.game?.slice(1).filter(n => facts(n).over !== 'checkmate');  // lila drops the mated position
  if (!moves?.length || moves.some(n => !n.eval)) return null;
  return accuracy(moves.map(n => n.eval), state.root.ply % 2 === 0);
}

// ---- Moving about ------------------------------------------------------------
function go(n) {
  if (!n || n === state.node) return;
  state.node = n;
  requestRender();
  analyse();
}

function play(uci) {
  const from = state.node;
  let next = from.children.find(c => c.uci === uci);
  if (!next) {
    try {
      const m = new Chess(from.fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      next = addNode(from, m.after, m);
    } catch { return requestRender(); }
    dirty.moves = true;
  }
  go(next);
}

const board = new Board($('.board'), {
  dests: sq => new Chess(state.node.fen).moves({ square: sq, verbose: true }).map(m => m.to),
  async onMove(from, to) {
    const n = state.node, c = new Chess(n.fen);
    const promotes = c.get(from)?.type === 'p' && /[18]$/.test(to);
    const piece = promotes ? await board.promote(to, c.turn()) : '';
    if (piece === null || state.node !== n) return requestRender();  // dismissed, or the board moved on
    play(from + to + piece);
  },
});

const graph = new Graph($('.graph'), ply => go(state.game[ply]));

// ---- Board analysis ------------------------------------------------------------
// Lite first so arrows arrive at once, then the full engine takes over.
let live = spawn(LITE, 3), liveUrl = LITE;
const reviewUrl = FULL === LITE ? Promise.resolve(LITE) : (() => {
  const full = spawn(FULL, 3);
  return full.ready.then(() => {
    live.terminate();
    [live, liveUrl] = [full, FULL];
    seen.clear();
    analyse();
    return FULL;
  }, () => LITE);  // no full engine: the lite one reviews too
})();

function analyse() {
  const n = state.node;
  if (live.dead) live = spawn(liveUrl, 3);
  if (!state.engineOn || facts(n).over || seen.get(n.fen)?.done) return live.stop();
  const engine = live;
  const keep = r => {
    const old = seen.get(r.fen);
    if (old && old !== r && old.lines[0]?.depth > (r.lines[0]?.depth ?? 0)) return;
    r.engine = engine.name;
    seen.set(r.fen, r);
    requestRender();
  };
  engine.search(n.fen, LIVE, keep, pathTo(n)).then(r => {
    if (!r) return;
    r.done = !r.stopped;
    if (r.lines[0]) keep(r);
  });
}

// The moves that led to n, so the engine sees repetitions as Lichess's does
function pathTo(n) {
  const moves = [];
  for (let m = n; m.parent; m = m.parent) moves.unshift(m.uci);
  return { root: state.root.fen, moves };
}

// What to show for a position: live lines, or failing that the review's line
function analysisOf(n) {
  const r = seen.get(n.fen);
  if (r?.lines[0]) return { engine: r.engine, depth: r.lines[0].depth, nps: r.lines[0].nps, lines: r.lines.filter(Boolean) };
  if (n.pv) return { engine: 'review', lines: [{ eval: n.eval, pv: n.pv }] };
  return null;
}

// ---- Game review ---------------------------------------------------------------
// A quick pass draws the whole curve, then a deep pass runs from the last move
// back to the first, so each search inherits the hash table of the positions
// that follow it. Finished reviews are kept in localStorage: reopening a game
// is instant and shows the same verdicts (threaded search varies run to run).
let reviewer = null, loads = 0;  // loads: a review or fetch for an older load gives up
const KEPT = `chess2:${FULL.pathname.split('/').pop()}:${DEEP}:`;

async function review() {
  const run = loads, line = state.game;
  const key = KEPT + line[0].fen + line.slice(1).map(n => n.uci).join(' ');
  const kept = recall(key);
  if (kept?.length === line.length) {
    line.forEach((n, i) => Object.assign(n, kept[i], { pass: 2 }));
    dirty.moves = dirty.graph = true;
    return requestRender();
  }
  const url = await reviewUrl;
  for (const [pass, limit, order] of [[1, SKETCH, line], [2, DEEP, [...line].reverse()]]) {
    for (const n of order) {
      if (run !== loads) return;
      const over = facts(n).over;
      const r = over ? null : await reviewSearch(url, n, limit);
      if (run !== loads) return;
      if (!over && !r?.lines[0]) return notice('The review stopped: Stockfish keeps crashing. Reload to retry.', true);
      Object.assign(n, over ? { eval: over === 'stalemate' ? { cp: 0 } : null, best: null, pv: null }
        : { eval: r.lines[0].eval, best: r.best, pv: r.lines[0].pv }, { pass });
      dirty.moves = dirty.graph = true;
      requestRender();
    }
  }
  if (url === FULL) store(key, line.map(n => ({ eval: n.eval, best: n.best, pv: n.pv?.slice(0, 12) })));
}

function recall(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function store(key, value) {
  const json = JSON.stringify(value);
  try { localStorage.setItem(key, json); } catch {
    try {  // full: forget old reviews and try once more
      Object.keys(localStorage).filter(k => k.startsWith('chess2:')).forEach(k => localStorage.removeItem(k));
      localStorage.setItem(key, json);
    } catch { /* storage unavailable: reviews just aren't kept */ }
  }
}

async function reviewSearch(url, n, limit) {
  for (let tries = 0; tries < 3; tries++) {
    if (!reviewer || reviewer.dead) reviewer = spawn(url, 1);
    const r = await reviewer.search(n.fen, limit, null, pathTo(n));
    if (r || !reviewer.dead) return r;  // null without a crash: a new game replaced this one
  }
  return null;
}

// ---- Loading games ---------------------------------------------------------------
function start(fen, moves = [], headers = {}, colour = null) {
  loads++;
  reviewer?.stop();
  nodes.clear();
  const root = addNode(null, fen);
  moves.reduce((n, m) => addNode(n, m.after, m), root);
  Object.assign(state, { root, headers, game: moves.length ? mainline(root) : null });
  const me = remembered();  // an explicit colour, else your side if you're playing, else as it was
  state.orientation = colour ?? (me && headers.Black === me ? 'black' : me && headers.White === me ? 'white' : state.orientation);
  dirty.moves = dirty.graph = true;
  go(root);
  if (state.game) review();
}

// Canonical FEN, or null if the side not to move is in check: chess.js allows
// that position, Stockfish aborts on it
function legal(fen) {
  const c = new Chess(fen), them = c.turn() === 'w' ? 'b' : 'w';
  return c.isAttacked(c.findPiece({ type: 'k', color: them })[0], c.turn()) ? null : c.fen();
}

function loadPgn(text, colour) {
  const c = new Chess();
  try { c.loadPgn(text.split(/\n\s*\n(?=\s*\[)/)[0]); } catch { return false; }  // the first of several games
  const moves = c.history({ verbose: true });
  const root = legal(moves[0]?.before ?? c.fen());
  if (root) start(root, moves, c.getHeaders(), colour);
  return !!root;
}

// True if the text was taken: a Lichess game link (8-character id, or 12 with
// the player's suffix; a bare word like "nonsense" is never sent), FEN or PGN
function load(text) {
  text = text.trim();
  const fail = message => (notice(message, true), false);
  if (!text) return false;
  const lichess = text.match(/^(?:https?:\/\/)?(?:www\.)?lichess\.org\/([a-zA-Z0-9]{8})(?:[a-zA-Z0-9]{4})?(?:[/?#]|$)/);
  if (lichess) return fetchLichess(lichess[1], /\/black\b/.test(text) ? 'black' : null), true;
  if (validateFen(text).ok) {
    const fen = legal(text);
    if (!fen) return fail('That position can’t happen: the side not to move is in check.');
    start(fen);
  } else if (!loadPgn(text)) return fail('That isn’t a PGN, a FEN or a Lichess game link.');
  history.replaceState(null, '', location.pathname);
  notice('');
  return true;
}

async function fetchLichess(id, colour) {
  const ticket = loads;
  notice('Fetching the game from Lichess…');
  try {
    const res = await fetch(`https://lichess.org/game/export/${id}?clocks=false&evals=false`,
      { headers: { Accept: 'application/x-chess-pgn' } });
    if (!res.ok) throw new Error(res.status === 404 ? 'Lichess has no game with that id.' : `Lichess replied ${res.status}.`);
    const pgn = await res.text();
    if (loads !== ticket) return;  // something else was loaded meanwhile
    if (!loadPgn(pgn, colour)) throw new Error('Lichess sent a game this board can’t read.');
    history.replaceState(null, '', `?game=${id}${colour === 'black' ? '&color=black' : ''}`);
    notice('');
  } catch (e) {
    notice(e.message.startsWith('Lichess') ? e.message : 'Couldn’t reach Lichess.', true);
  }
}

// The side you flip to is you: remembered, and used to orient your later games
function remembered() { try { return localStorage.getItem('chess2.me'); } catch { return null; } }

function flip() {
  state.orientation = state.orientation === 'white' ? 'black' : 'white';
  const me = state.headers[state.orientation === 'white' ? 'White' : 'Black'];
  if (me && me !== '?') try { localStorage.setItem('chess2.me', me); } catch {}
  requestRender();
}

function toggleEngine() {
  state.engineOn = !state.engineOn;
  analyse();
  requestRender();
}

// ---- Drawing -----------------------------------------------------------------
const dirty = { moves: true, graph: true };
let frame = 0, shownNode = null;
const requestRender = () => { frame ||= requestAnimationFrame(render); };

function render() {
  frame = 0;
  const n = state.node, a = state.engineOn ? analysisOf(n) : null;
  board.set({
    fen: n.fen,
    orientation: state.orientation,
    lastMove: n.uci ? [n.uci.slice(0, 2), n.uci.slice(2, 4)] : null,
    check: facts(n).check,
    arrows: a ? a.lines.map(l => [l.pv[0].slice(0, 2), l.pv[0].slice(2, 4)]) : [],
  });
  renderEngine(n, a);
  renderMoves(n);
  renderGame(n);
  shownNode = n;
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const fmt = e => !e ? '' : e.mate !== undefined ? `#${e.mate}`
  : `${e.cp > 0 ? '+' : e.cp < 0 ? '−' : ''}${(Math.abs(e.cp) / 100).toFixed(1)}`;
// The eval bar's fill: Lichess's winning-chances curve, except that a decided
// position (a forced mate, or ±10.00 and beyond) fills it completely
function barWin(e) {
  const decided = e.mate !== undefined ? Math.sign(e.mate) : Math.abs(e.cp) >= 1000 ? Math.sign(e.cp) : 0;
  return decided ? 50 + 50 * decided : winPercent(e);
}

// The eval bar's label: "0.3", "−1.2", "M3"
const short = e => !e ? '' : e.mate !== undefined ? `M${Math.abs(e.mate)}`
  : `${e.cp < 0 ? '−' : ''}${(Math.abs(e.cp) / 100).toFixed(1)}`;
const SYMBOL = { inaccuracy: '?!', mistake: '?', blunder: '??' };
const PLURAL = { inaccuracy: 'inaccuracies', mistake: 'mistakes', blunder: 'blunders' };

// innerHTML, written only when it changes (renders run every engine update)
function html(el, markup) {
  if (el.markup !== markup) el.innerHTML = el.markup = markup;
}

function renderEngine(n, a) {
  const over = facts(n).over, e = a?.lines[0]?.eval ?? n.eval;
  const win = over === 'checkmate' ? (whiteMoved(n) ? 100 : 0) : e ? barWin(e) : 50;
  const bar = $('.evalbar'), flipped = state.orientation === 'black';
  bar.style.setProperty('--white', `${win}%`);
  bar.classList.toggle('flipped', flipped);
  // The label sits at the foot of the bar: dark on white, light on black
  const label = 14 / bar.clientHeight * 100;  // its share of the bar, in %
  bar.classList.toggle('white-foot', flipped ? win > 100 - label : win > label);
  bar.dataset.score = over === 'checkmate' ? (whiteMoved(n) ? '1-0' : '0-1') : over ? '½-½' : short(e);
  $('.engine .score').textContent = over === 'checkmate' ? (whiteMoved(n) ? '1-0' : '0-1') : over ? '½-½' : fmt(e);
  $('.engine .info').textContent = !state.engineOn ? 'Engine off'
    : over ? (over === 'checkmate' ? 'Checkmate' : 'Stalemate')
    : a?.depth ? `${a.engine} · depth ${a.depth}${a.nps ? ` · ${(a.nps / 1e6).toFixed(1)} M/s` : ''}`
    : a ? 'From the game review' : 'Loading Stockfish…';
  $('.engine .toggle').setAttribute('aria-pressed', state.engineOn);
  html($('.engine .lines'), a ? a.lines.map(l =>
    `<li data-uci="${l.pv[0]}"><b>${fmt(l.eval)}</b>${sanLine(n.fen, l.pv)}</li>`).join('') : '');
  const tb = state.engineOn && tablebase(n);
  $('.engine .tb').textContent = tb ? `Tablebase: ${tb}` : '';
}

// UCI principal variation → numbered SAN, first dozen plies
const sanCache = new Map();
function sanLine(fen, pv) {
  const key = fen + pv.slice(0, 12).join(' ');
  if (sanCache.size > 500) sanCache.clear();
  if (!sanCache.has(key)) {
    const c = new Chess(fen);
    let ply = 2 * (fen.split(' ')[5] - 1) + (c.turn() === 'b'), out = '';
    for (const uci of pv.slice(0, 12)) {
      let m;
      try { m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { break; }
      out += (ply % 2 === 0 ? ` ${ply / 2 + 1}.` : out ? '' : ` ${(ply + 1) / 2}…`) + ` ${m.san}`;
      ply++;
    }
    sanCache.set(key, out);
  }
  return sanCache.get(key);
}

// Lichess tablebase for seven pieces or fewer: fetched once per position
const tbCache = new Map();
function tablebase(n) {
  if (facts(n).over || n.fen.split(' ')[0].replace(/[^a-z]/gi, '').length > 7) return null;
  if (!tbCache.has(n.fen)) {
    tbCache.set(n.fen, null);
    fetch(`https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(n.fen)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        const mover = facts(n).turn === 'w' ? 'White' : 'Black', other = mover === 'White' ? 'Black' : 'White';
        const verdict = { win: `${mover} wins`, 'maybe-win': `${mover} wins`, loss: `${other} wins`, 'maybe-loss': `${other} wins`,
          draw: 'draw', 'cursed-win': 'draw by the 50-move rule', 'blessed-loss': 'draw by the 50-move rule' }[d.category];
        if (verdict) tbCache.set(n.fen, verdict + (d.moves?.[0] ? ` · best ${d.moves[0].san}` : ''));
        requestRender();
      }, () => {});
  }
  return tbCache.get(n.fen);
}

function moveHtml(m) {
  const j = judgement(m);
  return `<span class="move" data-id="${m.id}">${m.san}${j ? `<i class="${j}">${SYMBOL[j]}</i>` : ''}</span>`;
}

// A side line, inline, with its own side lines in brackets
function lineHtml(m) {
  let out = '', number = true;
  for (let first = true; m; first = false, m = m.children[0]) {
    if (whiteMoved(m) || number) out += `<span class="num">${Math.ceil(m.ply / 2)}${whiteMoved(m) ? '.' : '…'}</span>`;
    out += moveHtml(m);
    const alts = first ? [] : m.parent.children.slice(1);
    out += alts.map(v => ` (${lineHtml(v)})`).join('');
    number = alts.length > 0;
  }
  return out;
}

// The main line as a two-column table; side lines break it full width
function movesHtml() {
  if (!state.root.children.length) return '<p class="hint">Make a move, or paste a game below.</p>';
  let html = '', broken = true;
  for (let n = state.root; n.children[0]; n = n.children[0]) {
    const m = n.children[0], alts = n.children.slice(1);
    if (whiteMoved(m)) html += `<span class="num">${(m.ply + 1) / 2}</span>`;
    else if (broken) html += `<span class="num">${m.ply / 2}</span><span class="move empty">…</span>`;
    html += moveHtml(m);
    broken = alts.length > 0;
    if (broken) html += (whiteMoved(m) ? '<span class="move empty"></span>' : '') +
      `<div class="alts">${alts.map(v => `<p>${lineHtml(v)}</p>`).join('')}</div>`;
  }
  const { Result, Termination } = state.headers;
  if (state.game && Result && Result !== '*') {
    html += `<p class="result">${esc(Result)}${Termination && Termination !== 'Normal' ? ` · ${esc(Termination)}` : ''}</p>`;
  }
  return html;
}

function renderMoves(n) {
  const list = $('.moves .list');
  if (dirty.moves) {
    dirty.moves = false;
    html(list, movesHtml());
    $('.moves .opening').textContent = opening(state.headers);
  }
  list.querySelector('.cur')?.classList.remove('cur');
  const cur = list.querySelector(`[data-id="${n.id}"]`);
  cur?.classList.add('cur');
  if (n !== shownNode) list.scrollTop = cur ? cur.offsetTop - list.clientHeight / 2 : n === state.root ? 0 : list.scrollHeight;
}

// "B20 Sicilian Defense: Mengarini Variation", from Lichess's Opening header
// or chess.com's ECOUrl slug
function opening({ ECO, Opening, ECOUrl }) {
  const name = Opening ?? (ECOUrl && decodeURIComponent(ECOUrl.split('/').pop()).replace(/-\d+\..*$/, '').replaceAll('-', ' '));
  return [ECO, name].filter(v => v && v !== '?').join(' ');
}

function renderGame(n) {
  const game = state.game;
  $('.graph').hidden = !game;
  if (game) {
    const done = game.filter(g => g.pass === 2).length;
    if (dirty.graph) {
      dirty.graph = false;
      graph.draw(game.map(g => ({
        win: g.eval ? winPercent(g.eval) : g === state.root ? winPercent(INITIAL)
          : facts(g).over === 'checkmate' ? (whiteMoved(g) ? 100 : 0) : null,
        judgement: judgement(g),
      })));
    }
    let m = n;
    while (!onMainline(m)) m = m.parent;
    const i = game.indexOf(m);
    graph.mark(i < 0 ? null : i);
    $('.graph').dataset.status = done === game.length ? '' : game.some(g => g.pass) ? `Reviewing ${done}/${game.length}` : 'Loading Stockfish 19…';
  }
  const acc = game && accuracies();
  for (const colour of ['white', 'black']) {
    const top = (colour === 'white') === (state.orientation === 'black');
    const el = $(top ? '.player.top' : '.player.bottom');
    const name = state.headers[colour === 'white' ? 'White' : 'Black'];
    const counts = Object.keys(SYMBOL).map(j => [j, game ? game.filter(g =>
      whiteMoved(g) === (colour === 'white') && judgement(g) === j).length : 0]);
    const diff = material(n.fen) * (colour === 'white' ? 1 : -1);
    html(el, (name && name !== '?' ? `<span class="name ${colour}">${esc(name)}</span>` : '') +
      `<span class="elo">${esc(state.headers[colour === 'white' ? 'WhiteElo' : 'BlackElo'])}</span>` +
      (acc?.[colour] != null ? `<span class="acc" title="Accuracy, as Lichess computes it">${Math.round(acc[colour])}%</span>` : '') +
      counts.map(([j, c]) => c ? `<span class="${j}" title="${c} ${c === 1 ? j : PLURAL[j]}">${c}${SYMBOL[j]}</span>` : '').join('') +
      (diff > 0 ? `<span class="material">+${diff}</span>` : ''));
  }
}

function material(fen) {  // White's material lead in pawns
  const value = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  let lead = 0;
  for (const ch of fen.split(' ')[0]) lead += (value[ch.toLowerCase()] ?? 0) * (ch < 'a' ? 1 : -1);
  return lead;
}

function notice(text, error = false) {
  const el = $('.foot .status');
  el.textContent = text;
  el.classList.toggle('error', error);
}

// ---- Input -------------------------------------------------------------------
// A one-row textarea rather than an input: an input silently deletes the line
// breaks of anything typed or dropped in, fusing "d4⏎9. Na4" into "d49. Na4".
const input = $('.load textarea');
input.addEventListener('paste', e => {
  e.preventDefault();
  load(e.clipboardData.getData('text'));
  input.blur();
});
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.form.requestSubmit(); }
});
$('.load').addEventListener('submit', e => {
  e.preventDefault();
  if (!load(input.value)) return;
  input.value = '';
  input.blur();
});

// Lists act on release, not press: a finger that starts scrolling one gets a
// pointercancel instead, and must not jump the board
function tap(el, pick, act) {
  let down = null;
  el.addEventListener('pointerdown', e => { down = e.button === 0 ? pick(e) : null; });
  el.addEventListener('pointercancel', () => { down = null; });
  el.addEventListener('pointerup', e => { if (down != null && down === pick(e)) act(down); down = null; });
}
tap($('.moves'), e => e.target.closest('.move[data-id]')?.dataset.id, id => go(nodes.get(+id)));
tap($('.engine .lines'), e => e.target.closest('[data-uci]')?.dataset.uci, play);
$('.engine .toggle').addEventListener('click', toggleEngine);

const keys = {
  ArrowLeft: () => go(state.node.parent),
  ArrowRight: () => go(state.node.children[0]),
  ArrowUp: () => go(state.root),
  Home: () => go(state.root),
  ArrowDown: () => go(mainline(state.node).at(-1)),
  End: () => go(mainline(state.node).at(-1)),
  Escape: () => { let m = state.node; while (!onMainline(m)) m = m.parent; go(m); },
  ' ': () => { const best = analysisOf(state.node)?.lines[0]?.pv[0]; if (best) play(best); },
  f: flip,
  t: toggleEngine,
  r: () => { history.replaceState(null, '', location.pathname); start(START); },
};
document.addEventListener('keydown', e => {
  if (e.target.closest('textarea') || (e.key === ' ' && e.target.closest('button')) ||
      e.ctrlKey || e.metaKey || e.altKey || !keys[e.key]) return;
  e.preventDefault();
  keys[e.key]();
});

// ---- Start -------------------------------------------------------------------
// ?game=<lichess id>&color=black, or #pgn=<pgn>&ply=<n>&color=black (the coach
// report links a game at the moment in question; a hash never reaches a server)
const params = new URLSearchParams(location.search), hash = new URLSearchParams(location.hash.slice(1));
const colour = (params.get('color') ?? hash.get('color')) === 'black' ? 'black' : null, game = params.get('game') ?? '';
start(START, [], {}, colour);
if (/^[a-zA-Z0-9]{8}$/.test(game)) fetchLichess(game, colour);
else if (hash.get('pgn') && loadPgn(hash.get('pgn'), colour)) go(state.game?.[+hash.get('ply')] ?? state.root);
