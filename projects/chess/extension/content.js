// HJD Chess Analysis: Lichess content script.
// Puts an "hjd" button on Lichess game pages that opens the game on the HJD
// analysis board.
//
// The button floats in the corner of the window, attached to <body>. It used
// to sit inside Lichess's own control bars; nothing here depends on Lichess's
// page layout any more.

const ANALYSIS_URL = 'https://hjd.ai/projects/chess/analysis.html';

// Pages whose first path segment is 8 or 12 letters long but isn't a game
const NOT_GAMES = new Set([
  'training', 'practice', 'analysis', 'streamer', 'features', 'calendar',
  'insights', 'timeline', 'notification',
]);

// A game lives at lichess.org/game/<id> (since 2026; before that, and still in
// old links, at lichess.org/<id>). The id is 8 characters; your own games carry
// four more (your seat in the game): lichess.org/game/abcdefgh1234.
function gameId() {
  const [, first = '', second = ''] = location.pathname.split('/');
  const name = first === 'game' ? second : first;
  if (NOT_GAMES.has(name) || !/^[a-zA-Z0-9]{8}([a-zA-Z0-9]{4})?$/.test(name)) return null;
  return name.slice(0, 8);
}

// The side to view the game from: the address says (/black), else the way up
// the board is, which on your own games is your side
function colour() {
  if (/\/black\b/.test(location.pathname)) return 'black';
  if (/\/white\b/.test(location.pathname)) return 'white';
  if (document.querySelector('.orientation-black')) return 'black';
  return 'white';
}

const href = id => `${ANALYSIS_URL}?game=${id}${colour() === 'black' ? '&color=black' : ''}`;

// Adds, updates or removes the button to match the page being shown
function sync() {
  const id = gameId();
  let btn = document.querySelector('.hjd-analyse-btn');
  if (!id) return btn?.remove();
  if (!btn) {
    btn = document.createElement('a');
    btn.className = 'hjd-analyse-btn';
    btn.target = '_blank';
    btn.rel = 'noopener';
    btn.textContent = 'hjd';
    btn.title = 'Open in HJD Chess Analysis';
    // The board may have been flipped since: settle the colour as the click begins
    for (const type of ['pointerdown', 'keydown', 'focus']) btn.addEventListener(type, () => { btn.href = href(btn.dataset.game); });
  }
  if (btn.dataset.game !== id) {
    btn.dataset.game = id;
    btn.href = href(id);
  }
  if (btn.parentElement !== document.body) document.body.appendChild(btn);
}

sync();

// Lichess swaps pages and redraws without reloading: keep the button in step.
// Only <body>'s own children are watched, plus the address.
new MutationObserver(sync).observe(document.body, { childList: true });
let path = location.pathname;
setInterval(() => { if (path !== location.pathname) { path = location.pathname; sync(); } }, 1000);
