// One Stockfish web worker, spoken to over UCI.
//
// Searches run one at a time. Asking for a new search stops the running one
// and waits for its `bestmove` before sending the next position: UCI replies
// are strictly sequential, so that is the only order in which every reply can
// be matched to its request. A search replaced before it starts resolves null,
// as does everything pending if the worker dies. No timeouts: a slow download
// is just slow, never an error.

export class Engine {
  name = '';
  dead = false;
  #worker;
  #ready = false;
  #running = null;
  #queued = null;
  #boot;

  constructor(url, options = {}) {
    this.ready = new Promise((resolve, reject) => { this.#boot = { resolve, reject }; });
    this.ready.catch(() => {});  // callers that care await it; the rest see `dead`
    this.#worker = new Worker(url);
    this.#worker.onmessage = e => this.#receive(String(e.data));
    this.#worker.onerror = () => this.#die();  // failed load, WASM abort, out of memory
    this.#send('uci');
    for (const [name, value] of Object.entries(options)) this.#send(`setoption name ${name} value ${value}`);
    this.#send('isready');
  }

  // Resolves { fen, lines, best, stopped } once the search ends; lines[i] is
  // the latest info for MultiPV line i+1. onInfo(result) fires as lines arrive.
  // `path` ({ root, moves }) sends the moves that led here, as Lichess does, so
  // the engine sees repetitions; `fen` is still the position searched.
  search(fen, go, onInfo, path) {
    return new Promise(resolve => {
      this.#queued?.resolve(null);
      this.#queued = { fen, go, onInfo, path, resolve, lines: [], best: null, stopped: false };
      if (this.dead) this.#die();
      else if (this.#running) this.#stopRunning();
      else this.#start();
    });
  }

  stop() {
    this.#queued?.resolve(null);
    this.#queued = null;
    if (this.#running) this.#stopRunning();
  }

  terminate() { this.#die(); }

  #send(cmd) { this.#worker.postMessage(cmd); }

  #stopRunning() {
    if (this.#running.stopped) return;
    this.#running.stopped = true;
    this.#send('stop');
  }

  #start() {
    if (!this.#ready || !this.#queued) return;
    const job = this.#running = this.#queued;
    this.#queued = null;
    const { path } = job;
    this.#send(path?.moves.length ? `position fen ${path.root} moves ${path.moves.join(' ')}` : `position fen ${job.fen}`);
    this.#send(`go ${job.go}`);
  }

  #receive(line) {
    const job = this.#running;
    if (line === 'readyok') {
      this.#ready = true;
      this.#boot.resolve(this);
      this.#start();
    } else if (line.startsWith('id name ')) {
      this.name = line.slice(8).replace(/ WASM.*/, '');
    } else if (job && line.startsWith('info ')) {
      const info = parseInfo(line, job.fen);
      if (!info) return;
      job.lines[info.multipv - 1] = info;
      job.onInfo?.(job);
    } else if (job && line.startsWith('bestmove')) {
      this.#running = null;
      job.best = line.split(' ')[1];
      job.resolve(job);
      this.#start();
    }
  }

  #die() {
    this.#worker.terminate();  // also a crashed one: its memory and threads go with it
    this.dead = true;
    this.#boot.reject(new Error('engine stopped'));
    this.#running?.resolve(null);
    this.#queued?.resolve(null);
    this.#running = this.#queued = null;
  }
}

// "info depth 20 … multipv 1 score cp 21 … nps 2706152 … pv d2d3 f8c5 …"
// → { depth, multipv, eval, nps, pv }, eval from White's point of view.
// Skipped: aspiration-window bounds (guesses, not results) and the empty
// "pv " Stockfish prints when stopped before finishing depth 1.
function parseInfo(line, fen) {
  const t = line.trim().split(' ');
  const at = key => t.indexOf(key);
  const score = at('score'), pv = at('pv');
  if (score < 0 || pv < 0 || pv === t.length - 1 || /bound/.test(t[score + 3])) return null;
  const n = (fen.split(' ')[1] === 'w' ? 1 : -1) * t[score + 2];
  return {
    depth: +t[at('depth') + 1],
    multipv: at('multipv') < 0 ? 1 : +t[at('multipv') + 1],
    eval: t[score + 1] === 'mate' ? { mate: n } : { cp: n },
    nps: at('nps') < 0 ? 0 : +t[at('nps') + 1],
    pv: t.slice(pv + 1),
  };
}
