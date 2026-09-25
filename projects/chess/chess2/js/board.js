// The chessboard view. Positions are laid out in board fractions (a square is
// 12.5% of the board) and every pointer event is resolved against the board's
// on-screen rectangle at the moment it happens, so page zoom, scrolling, CSS
// transforms and flipping can never skew which square a drop lands on.
//
// Moves by drag or by click-click, with mouse, touch or pen, and pieces jump
// straight to their squares: no animation. The board knows no chess:
// `dests(square)` supplies legal targets, `onMove(from, to)` hears moves, and
// `onDropOff(square)`, if given, hears a piece dragged off the board.

const FILES = 'abcdefgh';

export class Board {
  orientation = 'white';
  #fen = null;
  #pieces = new Map();  // square → element
  #marks = { last: null, check: null, key: '' };
  #arrowKey = '';
  #selected = null;
  #dests = [];
  #drag = null;
  #hover = null;
  #promoting = false;

  constructor(el, { dests, onMove, onDropOff = null }) {
    this.el = el;
    this.dests = dests;
    this.onMove = onMove;
    this.onDropOff = onDropOff;
    el.innerHTML = '<div class="marks"></div><div class="pieces"></div>' +
      '<svg class="arrows" viewBox="0 0 8 8"></svg><div class="coords"></div>';
    [this.marksEl, this.piecesEl, this.arrowsEl, this.coordsEl] = el.children;
    el.addEventListener('pointerdown', e => this.#down(e));
    el.addEventListener('pointermove', e => this.#move(e));
    el.addEventListener('pointerup', e => this.#up(e));
    el.addEventListener('pointercancel', e => this.#up(e, true));
    el.addEventListener('contextmenu', e => e.preventDefault());
    this.#coords();
  }

  // arrows: [[from, to, class?], …] in order of importance
  set({ fen, orientation = 'white', lastMove = null, check = null, arrows = [] }) {
    if (this.#promoting) return;  // hold the pawn on its new square until a piece is chosen
    const flipped = orientation !== this.orientation;
    this.orientation = orientation;
    if (fen !== this.#fen || flipped) {
      if (fen !== this.#fen) this.#select(null);
      this.#drag?.el.classList.remove('dragging');  // a drag the position changed under
      this.#drag = this.#hover = null;
      this.#fen = fen;
      this.el.dataset.fen = fen;
      this.#render(placement(fen));
      if (flipped) this.#coords();
    }
    Object.assign(this.#marks, { last: lastMove, check });
    this.#drawMarks();
    this.#drawArrows(arrows);
  }

  // Ask which piece a pawn on `square` becomes: 'q' | 'r' | 'b' | 'n', or null
  // when dismissed (a press outside the four pieces, or Esc). The four sit on a
  // card on the board's own grid: the queen on the promotion square, where the
  // pointer already is, and the rest opening towards the middle of the board.
  promote(square, colour) {
    return new Promise(resolve => {
      const [col, row] = this.#xy(square), dx = col < 4 ? 1 : -1, dy = row < 4 ? 1 : -1;
      const left = Math.min(col, col + dx), top = Math.min(row, row + dy);
      const spots = { q: [col, row], r: [col + dx, row], b: [col, row + dy], n: [col + dx, row + dy] };
      const box = document.createElement('div');
      box.className = 'promotion';
      box.innerHTML = `<div class="card" style="left:${left * 12.5}%;top:${top * 12.5}%">` +
        Object.entries(spots).map(([p, [c, r]]) => `<button class="piece ${colour}${p.toUpperCase()}" data-piece="${p}" ` +
          `aria-label="${{ q: 'Queen', n: 'Knight', r: 'Rook', b: 'Bishop' }[p]}" ` +
          `style="left:${(c - left) * 50}%;top:${(r - top) * 50}%"></button>`).join('') + '</div>';
      const done = piece => {
        box.remove();
        removeEventListener('keydown', esc);
        this.#promoting = false;
        resolve(piece);
      };
      const esc = e => e.key === 'Escape' && done(null);
      box.addEventListener('pointerdown', e => { e.stopPropagation(); if (!e.target.dataset.piece) done(null); });
      box.addEventListener('click', e => e.target.dataset.piece && done(e.target.dataset.piece));
      addEventListener('keydown', esc);
      this.#promoting = true;
      this.el.append(box);
      box.querySelector('button').focus();  // the queen: Enter takes it
    });
  }

  // The square under a screen point, or null off the board
  squareAt(x, y) { return this.#square({ clientX: x, clientY: y }); }

  get #white() { return this.orientation === 'white'; }

  // square → [column, row] as seen on screen
  #xy(sq) {
    const f = FILES.indexOf(sq[0]), r = sq[1] - 1;
    return this.#white ? [f, 7 - r] : [7 - f, r];
  }

  // Screen point → fractions of the board, and → square (null off the board)
  #fraction(e) {
    const b = this.el.getBoundingClientRect();
    return [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height];
  }

  #square(e) {
    const [fx, fy] = this.#fraction(e);
    const col = Math.floor(fx * 8), row = Math.floor(fy * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return this.#white ? FILES[col] + (8 - row) : FILES[7 - col] + (row + 1);
  }

  #place(el, sq) { el.style.cssText = at(...this.#xy(sq)); }

  // Diff the pieces: an element whose piece moved glides to its new square
  // (nearest same-kind element wins), captured ones go, new ones appear.
  #render(next) {
    const kept = new Map(), free = [];
    for (const [sq, el] of this.#pieces) (next.get(sq) === el.dataset.piece ? kept.set(sq, el) : free.push([sq, el]));
    for (const [sq, piece] of next) {
      if (kept.has(sq)) continue;
      let best = -1;
      free.forEach(([from, el], i) => {
        if (el.dataset.piece === piece && (best < 0 || distance(from, sq) < distance(free[best][0], sq))) best = i;
      });
      const el = best >= 0 ? free.splice(best, 1)[0][1] : this.piecesEl.appendChild(document.createElement('div'));
      el.className = `piece ${piece}`;
      el.dataset.piece = piece;
      kept.set(sq, el);
    }
    for (const [, el] of free) el.remove();
    for (const [sq, el] of kept) this.#place(el, sq);
    this.#pieces = kept;
  }

  #down(e) {
    if (e.button !== 0 || this.#promoting || this.#drag) return;
    const sq = this.#square(e);
    if (!sq) return;
    if (this.#selected && this.#dests.includes(sq)) return this.#play(this.#selected, sq);
    const dests = this.dests(sq);
    if (!dests.length || !this.#pieces.has(sq)) return this.#select(null);
    e.preventDefault();
    this.el.setPointerCapture(e.pointerId);
    this.#drag = { id: e.pointerId, sq, x: e.clientX, y: e.clientY, moved: false, again: this.#selected === sq, el: this.#pieces.get(sq) };
    this.#select(sq, dests);
  }

  #move(e) {
    const d = this.#drag;
    if (!d || e.pointerId !== d.id || (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4)) return;
    d.moved = true;
    d.el.classList.add('dragging');
    const [fx, fy] = this.#fraction(e);
    d.el.style.transform = `translate(${(fx * 8 - 0.5) * 100}%, ${(fy * 8 - 0.5) * 100}%)`;
    const hover = this.#square(e);
    if (hover !== this.#hover) { this.#hover = hover; this.#drawMarks(); }
  }

  #up(e, cancelled = false) {
    const d = this.#drag;
    if (!d || e.pointerId !== d.id) return;  // a second finger, a palm
    this.#drag = this.#hover = null;
    d.el.classList.remove('dragging');
    const to = cancelled ? null : this.#square(e);
    if (d.moved && to && to !== d.sq && this.#dests.includes(to)) return this.#play(d.sq, to);
    this.#place(d.el, d.sq);  // back home: a click, or a drop somewhere illegal
    if (d.moved && !to && !cancelled && this.onDropOff) {
      this.#fen = null;  // the next set() redraws, whatever it is given
      this.#select(null);
      return this.onDropOff(d.sq);
    }
    if (d.moved ? to !== d.sq : d.again) this.#select(null);
    else this.#drawMarks();
  }

  #play(from, to) {
    const el = this.#pieces.get(from);
    if (el) this.#place(el, to);  // shown there while a promotion is chosen
    this.#fen = null;             // the next set() redraws, whatever it is given
    this.#select(null);
    this.onMove(from, to);
  }

  #select(sq, dests = []) {
    this.#selected = sq;
    this.#dests = sq ? dests : [];
    this.#drawMarks();
  }

  #drawMarks() {
    const { last, check } = this.#marks, marks = [];
    if (last) marks.push([last[0], 'last'], [last[1], 'last']);
    if (check) marks.push([check, 'check']);
    if (this.#selected) marks.push([this.#selected, 'selected']);
    for (const sq of this.#dests) marks.push([sq, this.#pieces.has(sq) ? 'capture' : 'dest']);
    if (this.#hover) marks.push([this.#hover, 'hover']);
    const html = marks.map(([sq, kind]) => `<i class="${kind}" style="${at(...this.#xy(sq))}"></i>`).join('');
    if (html !== this.#marks.key) this.marksEl.innerHTML = this.#marks.key = html;
  }

  #drawArrows(arrows) {
    const key = this.orientation + arrows.join();
    if (key === this.#arrowKey) return;
    this.#arrowKey = key;
    const centre = sq => this.#xy(sq).map(v => v + 0.5);
    this.arrowsEl.innerHTML = arrows.map(([from, to, cls], i) =>
      `<path${cls ? ` class="${cls}"` : ''} d="${arrow(centre(from), centre(to), 0.2 - i * 0.04)}" opacity="${0.8 - i * 0.2}"/>`).join('');
  }

  // File letters along the bottom edge, rank numbers down the left
  #coords() {
    this.coordsEl.innerHTML = [...FILES].map((f, i) =>
      `<span class="file" style="left:${i * 12.5}%">${this.#white ? f : FILES[7 - i]}</span>` +
      `<span class="rank" style="top:${i * 12.5}%">${this.#white ? 8 - i : i + 1}</span>`).join('');
  }
}

const at = (col, row) => `transform:translate(${col * 100}%,${row * 100}%)`;

const distance = (a, b) => Math.hypot(a.charCodeAt(0) - b.charCodeAt(0), a[1] - b[1]);

// FEN → Map(square → 'wK' …)
function placement(fen) {
  const map = new Map();
  fen.split(' ')[0].split('/').forEach((rank, r) => {
    let f = 0;
    for (const ch of rank) {
      if (ch > '0' && ch <= '8') f += +ch;
      else map.set(FILES[f++] + (8 - r), (ch < 'a' ? 'w' : 'b') + ch.toUpperCase());
    }
  });
  return map;
}

// Closed outline of an arrow from centre a to centre b, `w` squares wide
function arrow([x1, y1], [x2, y2], w) {
  const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const head = 0.45, half = Math.max(w * 1.25, 0.24);
  const bx = x2 - ux * head, by = y2 - uy * head;
  const side = (x, y, d) => `${(x - uy * d).toFixed(3)} ${(y + ux * d).toFixed(3)}`;
  return `M${side(x1, y1, w / 2)}L${side(bx, by, w / 2)}L${side(bx, by, half)}L${x2} ${y2}` +
    `L${side(bx, by, -half)}L${side(bx, by, -w / 2)}L${side(x1, y1, -w / 2)}Z`;
}
