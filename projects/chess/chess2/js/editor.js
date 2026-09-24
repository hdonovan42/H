// Setting up a position by hand, from the position on the board. Pieces come
// from a palette in the side panel: drag one onto a square, or pick one (click
// it, or type its FEN letter, K Q R B N P for White and k q r b n p for Black)
// and click or sweep across squares to place it; clicking a square that holds
// the picked piece takes it off. Pieces on the board drag anywhere; dragged off
// the board or right-clicked, they go. The kings are always there, one each:
// placing a king moves it, and nothing removes or covers one. Pawns never stand
// on the first or last rank. The result is a FEN.

const FILES = 'abcdefgh';
const SQUARES = [...FILES].flatMap(f => [1, 2, 3, 4, 5, 6, 7, 8].map(r => f + r));
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const RIGHTS = { K: ['wK', 'e1', 'h1'], Q: ['wK', 'e1', 'a1'], k: ['bK', 'e8', 'h8'], q: ['bK', 'e8', 'a8'] };
const NAMES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };
const backRank = (piece, sq) => piece[1] === 'P' && (sq[1] === '1' || sq[1] === '8');
const isKing = piece => piece?.[1] === 'K';

// FEN → { pieces: Map(square → 'wK' …), turn, rights, ep, half, full }, or null
function parse(fen) {
  const [placement, turn = 'w', castling = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/);
  const ranks = placement?.split('/');
  if (ranks?.length !== 8 || !/^[wb]$/.test(turn)) return null;
  const pieces = new Map();
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of ranks[r]) {
      if (ch >= '1' && ch <= '8') f += +ch;
      else if (/[pnbrqk]/i.test(ch) && f < 8) pieces.set(FILES[f++] + (8 - r), (ch < 'a' ? 'w' : 'b') + ch.toUpperCase());
      else return null;
    }
    if (f !== 8) return null;
  }
  const kings = [...pieces.values()].filter(isKing);
  if (kings.length !== 2 || kings[0] === kings[1]) return null;  // one each, always
  return { pieces, turn, rights: new Set(castling.replace(/[^KQkq]/g, '')), ep, half, full };
}

function placementOf(pieces) {
  return [8, 7, 6, 5, 4, 3, 2, 1].map(r => {
    let row = '', gap = 0;
    for (const f of FILES) {
      const p = pieces.get(f + r);
      if (!p) { gap++; continue; }
      row += (gap || '') + (p[0] === 'w' ? p[1] : p[1].toLowerCase());
      gap = 0;
    }
    return row + (gap || '');
  }).join('/');
}

export class Editor {
  active = false;
  #pieces = new Map();
  #turn = 'w';
  #rights = new Set();
  #full = '1';     // the move number
  #source = null;  // the position it opened on: its en passant square and clocks carry over if nothing changes
  #tool = null;    // 'wP' … or 'eraser'
  #sweep = null;

  // board: the Board; el: the panel to draw into; legal(fen): a FEN or null;
  // changed(): redraw; done(fen): finished (null for cancel)
  constructor({ board, el, legal, changed, done }) {
    Object.assign(this, { board, el, legal, changed, done });
    el.innerHTML = `
      <div class="palette"></div>
      <div class="controls">
        <p class="seg"><button type="button" data-turn="w">White to move</button><button type="button" data-turn="b">Black to move</button></p>
        <p class="castling"><span>Castling</span>${[['K', 'White O-O'], ['Q', 'White O-O-O'], ['k', 'Black O-O'], ['q', 'Black O-O-O']]
          .map(([r, label]) => `<label><input type="checkbox" data-right="${r}"> ${label}</label>`).join('')}</p>
        <p class="tools"><button type="button" data-do="start" title="s">Start position</button><button type="button" data-do="clear" title="c">Empty board</button><button type="button" data-tool="eraser" title="x">Eraser</button></p>
        <p class="fen-row"><input class="fen" spellcheck="false" autocomplete="off" aria-label="FEN"><button type="button" class="copy" data-do="copy" title="Copy the FEN">Copy</button></p>
        <p class="reason" role="status"></p>
        <p class="go"><button type="button" class="primary" data-do="analyse" title="Enter">Analyse</button><button type="button" data-do="cancel" title="Esc">Cancel</button></p>
      </div>
      <div class="palette"></div>`;
    this.palettes = [...el.querySelectorAll('.palette')];
    this.fenInput = el.querySelector('.fen');
    this.reasonEl = el.querySelector('.reason');

    el.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (e.detail) b.blur();  // clicked, not keyed: Enter and Esc stay the editor's
      if (b.dataset.turn) { this.#turn = b.dataset.turn; this.changed(); }
      if (b.dataset.tool && (e.detail === 0 || !b.closest('.palette'))) this.arm(b.dataset.tool);  // palette clicks are handled on release
      ({ start: () => this.#load(START), clear: () => this.clear(), analyse: () => this.finish(), cancel: () => this.cancel(),
        copy: () => this.#copy(b) })[b.dataset.do]?.();
    });
    el.addEventListener('change', e => {
      const r = e.target.dataset.right;
      if (r) { e.target.checked ? this.#rights.add(r) : this.#rights.delete(r); this.changed(); }
    });
    this.fenInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.fenInput.blur(); }
      if (e.key === 'Escape') { this.fenInput.value = this.fen; this.fenInput.blur(); }
    });
    this.fenInput.addEventListener('change', () => {
      if (!this.#load(this.fenInput.value, true)) this.reasonEl.textContent = 'That isn’t a FEN.';
    });
    for (const p of this.palettes) p.addEventListener('pointerdown', e => this.#fromPalette(e));

    // With a piece picked, the board places it: click, or sweep across squares
    const own = (type, fn) => board.el.addEventListener(type, e => {
      if (!this.active || !fn(e)) return;
      e.stopImmediatePropagation();  // the board's own dragging stays out of it
      e.preventDefault();
    }, true);
    own('pointerdown', e => {
      if (!this.#tool || e.button !== 0) return false;
      const sq = board.squareAt(e.clientX, e.clientY);
      if (!sq) return false;
      board.el.setPointerCapture(e.pointerId);
      this.#sweep = { id: e.pointerId, last: null,
        erase: this.#tool === 'eraser' || (this.#pieces.get(sq) === this.#tool && !isKing(this.#tool)) };
      this.#stamp(sq);
      return true;
    });
    own('pointermove', e => {
      if (e.pointerId !== this.#sweep?.id) return false;
      const sq = board.squareAt(e.clientX, e.clientY);
      if (sq) this.#stamp(sq);
      return true;
    });
    for (const type of ['pointerup', 'pointercancel']) own(type, e => {
      if (e.pointerId !== this.#sweep?.id) return false;
      this.#sweep = null;
      return true;
    });
    board.el.addEventListener('contextmenu', e => {
      const sq = this.active && board.squareAt(e.clientX, e.clientY);
      if (sq) this.remove(sq);
    });
  }

  open(fen) {
    this.active = true;
    this.#tool = null;
    this.#source = fen;
    this.#load(fen);
  }

  get fen() {
    const src = parse(this.#source) ?? parse(START);
    const placement = placementOf(this.#pieces);
    const same = placement === placementOf(src.pieces) && this.#turn === src.turn;
    const rights = [...'KQkq'].filter(r => this.#rights.has(r) && this.#possible(r)).join('') || '-';
    return `${placement} ${this.#turn} ${rights} ${same ? src.ep : '-'} ${same ? src.half : 0} ${this.#full}`;
  }

  // Why the position can't be analysed, or null
  reason() {
    let ok;
    try { ok = this.legal(this.fen); } catch { return 'That position isn’t legal.'; }
    if (ok) return null;
    const [mover, other] = this.#turn === 'w' ? ['White', 'Black'] : ['Black', 'White'];
    return `${other} is in check with ${mover} to move.`;
  }

  // Board hooks: pieces drag anywhere but onto a king (a pawn never to the first or last rank)
  dests(sq) {
    const p = this.#pieces.get(sq);
    return p && !this.#tool ? SQUARES.filter(s => s !== sq && !backRank(p, s) && !isKing(this.#pieces.get(s))) : [];
  }

  move(from, to) {
    const p = this.#pieces.get(from);
    if (isKing(this.#pieces.get(to))) return;
    this.#pieces.delete(from);
    this.#place(to, p);
    this.changed();
  }

  remove(sq) {
    if (!isKing(this.#pieces.get(sq)) && this.#pieces.delete(sq)) this.changed();
  }

  // Everything but the kings
  clear() {
    for (const [sq, p] of this.#pieces) if (!isKing(p)) this.#pieces.delete(sq);
    this.#rights = new Set('KQkq');  // put the kings and rooks home and castling is on again
    this.changed();
  }

  arm(tool) {
    this.#tool = tool === this.#tool ? null : tool;
    this.changed();
  }

  finish() {
    if (this.reason()) return;
    this.active = false;
    this.done(this.fen);
  }

  cancel() {
    this.active = false;
    this.done(null);
  }

  get keys() {
    const keys = { s: () => this.#load(START), c: () => this.clear(), x: () => this.arm('eraser'),
      Enter: () => this.finish(), e: () => this.finish(),
      Escape: () => this.#tool ? this.arm(null) : this.cancel() };
    for (const ch of 'KQRBNPkqrbnp') keys[ch] = () => this.arm((ch < 'a' ? 'w' : 'b') + ch.toUpperCase());
    return keys;
  }

  render(orientation) {
    this.board.set({ fen: this.fen, orientation });
    this.board.el.classList.toggle('armed', !!this.#tool);
    // Each colour's pieces on its own side of the board
    const colours = orientation === 'white' ? ['b', 'w'] : ['w', 'b'];
    this.palettes.forEach((el, i) => {
      const c = colours[i], key = c + this.#tool;
      if (el.key === key) return;
      el.key = key;
      el.innerHTML = [...'KQRBNP'].map(p => `<button type="button" class="${c}${p}" data-tool="${c}${p}" ` +
        `aria-label="${c === 'w' ? 'White' : 'Black'} ${NAMES[p]} (${c === 'w' ? p : p.toLowerCase()})" ` +
        `aria-pressed="${this.#tool === c + p}"></button>`).join('');
    });
    for (const b of this.el.querySelectorAll('[data-turn]')) b.setAttribute('aria-pressed', b.dataset.turn === this.#turn);
    this.el.querySelector('[data-tool="eraser"]').setAttribute('aria-pressed', this.#tool === 'eraser');
    for (const box of this.el.querySelectorAll('[data-right]')) {
      box.disabled = !this.#possible(box.dataset.right);
      box.checked = !box.disabled && this.#rights.has(box.dataset.right);
    }
    if (document.activeElement !== this.fenInput) this.fenInput.value = this.fen;
    const why = this.reason();
    this.reasonEl.textContent = why ?? '';
    this.el.querySelector('[data-do="analyse"]').disabled = !!why;
  }

  // A FEN into the editor; one typed in also stands in for the position it opened on
  #load(fen, typed = false) {
    const p = parse(fen);
    if (!p) return false;
    this.#pieces = new Map([...p.pieces].filter(([sq, piece]) => !backRank(piece, sq)));
    this.#turn = p.turn;
    this.#rights = p.rights;
    this.#full = /^\d+$/.test(p.full) ? p.full : '1';
    if (typed) this.#source = fen;
    this.changed();
    return true;
  }

  // The FEN to the clipboard; where that's refused, selected for Ctrl+C
  async #copy(button) {
    try {
      await navigator.clipboard.writeText(this.fen);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    } catch {
      this.fenInput.focus();
      this.fenInput.select();
    }
  }

  #possible(r) {
    const [king, home, rook] = RIGHTS[r];
    return this.#pieces.get(home) === king && this.#pieces.get(rook) === king[0] + 'R';
  }

  // Place a piece: false if it can't go there (a pawn on the edge, anything on a king)
  #place(sq, piece) {
    if (backRank(piece, sq) || (isKing(this.#pieces.get(sq)) && this.#pieces.get(sq) !== piece)) return false;
    if (isKing(piece)) for (const [s, p] of this.#pieces) if (p === piece) this.#pieces.delete(s);
    this.#pieces.set(sq, piece);
    return true;
  }

  #stamp(sq) {
    const s = this.#sweep;
    if (sq === s.last) return;
    s.last = sq;
    if (s.erase) { if (!isKing(this.#pieces.get(sq)) && (this.#pieces.get(sq) === this.#tool || this.#tool === 'eraser')) this.#pieces.delete(sq); }
    else this.#place(sq, this.#tool);
    this.changed();
  }

  // Press on a palette piece: a click picks it, a drag places one where it's dropped
  #fromPalette(e) {
    const b = e.target.closest('button[data-tool]');
    if (!b || e.button !== 0) return;
    e.preventDefault();  // no focus, no text selection
    b.setPointerCapture(e.pointerId);
    const tool = b.dataset.tool, x = e.clientX, y = e.clientY;
    let ghost = null;
    const move = ev => {
      if (ev.pointerId !== e.pointerId || (!ghost && Math.hypot(ev.clientX - x, ev.clientY - y) < 4)) return;
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = `ghost ${tool}`;
        ghost.style.width = ghost.style.height = `${this.board.el.getBoundingClientRect().width / 8}px`;
        document.body.append(ghost);
      }
      ghost.style.left = `${ev.clientX}px`;
      ghost.style.top = `${ev.clientY}px`;
    };
    const end = ev => {
      if (ev.pointerId !== e.pointerId) return;
      b.removeEventListener('pointermove', move);
      b.removeEventListener('pointerup', end);
      b.removeEventListener('pointercancel', end);
      if (ghost) {
        ghost.remove();
        const sq = ev.type === 'pointerup' && this.board.squareAt(ev.clientX, ev.clientY);
        if (sq && this.#place(sq, tool)) this.changed();
      } else if (ev.type === 'pointerup') this.arm(tool);
    };
    b.addEventListener('pointermove', move);
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
  }
}
