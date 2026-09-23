// The game's evaluation graph: White's winning chances per ply on Lichess's
// scale, so +3 reads as a real advantage and mates saturate rather than
// dwarfing everything. SVG drawn in ply × percent units and stretched to fit;
// dots use a non-scaling stroke so they stay round. Press or drag to seek.

export class Graph {
  #plies = 0;

  constructor(el, onSeek) {
    el.innerHTML = '<svg preserveAspectRatio="none"><path class="area"/>' +
      '<line class="mid" x1="0" y1="50" y2="50"/><g class="dots"></g><line class="cursor" y1="0" y2="100"/></svg>';
    [this.svg] = el.children;
    [this.area, this.mid, this.dots, this.cursor] = this.svg.children;
    const seek = e => {
      const b = el.getBoundingClientRect();
      onSeek(Math.max(0, Math.min(this.#plies, Math.round((e.clientX - b.left) / b.width * this.#plies))));
    };
    el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); seek(e); });
    el.addEventListener('pointermove', e => { if (e.buttons) seek(e); });
  }

  // points: [{ win: 0-100 | null, judgement }] for plies 0…n (null: not known yet)
  draw(points) {
    const n = this.#plies = Math.max(1, points.length - 1);
    let last = 50;
    const ys = points.map(p => 100 - (last = p.win ?? last));
    this.svg.setAttribute('viewBox', `0 0 ${n} 100`);
    this.area.setAttribute('d', `M0 100${ys.map((y, i) => `L${i} ${y.toFixed(2)}`).join('')}L${points.length - 1} 100Z`);
    this.mid.setAttribute('x2', n);
    this.dots.innerHTML = points.map((p, i) => p.judgement
      ? `<line class="${p.judgement}" x1="${i}" x2="${i}" y1="${ys[i]}" y2="${ys[i]}"/>` : '').join('');
  }

  // Ply to mark, or null to hide the cursor
  mark(ply) {
    this.cursor.style.display = ply === null ? 'none' : '';
    this.cursor.setAttribute('x1', ply ?? 0);
    this.cursor.setAttribute('x2', ply ?? 0);
  }
}
