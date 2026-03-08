// HJD Chess Analysis — Lichess content script
// Adds an "Analyse on HJD" button to Lichess game pages

const ANALYSIS_URL = 'https://hjd.ai/projects/chess/analysis.html';

// Lichess game IDs are 8 alphanumeric characters
function extractGameId() {
  const match = window.location.pathname.match(/^\/([a-zA-Z0-9]{8})/);
  return match ? match[1] : null;
}

function isGamePage() {
  // Game pages have an 8-char ID as the first path segment
  // Exclude known non-game paths
  const nonGamePaths = [
    'training', 'learn', 'practice', 'study', 'tournament',
    'swiss', 'simul', 'team', 'forum', 'blog', 'api', 'editor',
    'analysis', 'inbox', 'coach', 'broadcast', 'streamer', 'tv',
    'variant', 'about', 'faq', 'contact', 'tos', 'privacy',
    'source', 'patron', 'thanks', 'developers', 'mobile'
  ];
  const firstSegment = window.location.pathname.split('/')[1];
  if (!firstSegment || nonGamePaths.includes(firstSegment)) return false;
  if (firstSegment === '@') return false;

  return /^[a-zA-Z0-9]{8}$/.test(firstSegment);
}

function detectUserColor() {
  // Check URL suffix: /black means user played black
  const path = window.location.pathname;
  if (path.endsWith('/black')) return 'black';
  if (path.endsWith('/white')) return 'white';

  // Detect from Lichess board orientation — the board is always oriented
  // with the user's colour at the bottom. The cg-wrap element has
  // orientation-white or orientation-black as a class.
  const cgWrap = document.querySelector('cg-wrap');
  if (cgWrap) {
    if (cgWrap.classList.contains('orientation-black')) return 'black';
    if (cgWrap.classList.contains('orientation-white')) return 'white';
  }

  // Fallback: check the .ruser-bottom element for colour
  const bottomUser = document.querySelector('.ruser-bottom');
  if (bottomUser) {
    const isBlack = bottomUser.querySelector('.color-icon.black')
      || bottomUser.classList.contains('black');
    if (isBlack) return 'black';
  }

  return null;
}

function createButton(gameId) {
  const btn = document.createElement('a');
  btn.className = 'hjd-analyse-btn';

  const color = detectUserColor();
  let href = `${ANALYSIS_URL}?game=${gameId}`;
  if (color === 'black') href += '&flip=1';

  btn.href = href;
  btn.target = '_blank';
  btn.rel = 'noopener';
  btn.textContent = 'hjd';
  btn.title = 'Open in HJD Chess Analysis';
  return btn;
}

function injectButton() {
  if (!isGamePage()) return;

  const gameId = extractGameId();
  if (!gameId) return;

  // Don't inject twice
  if (document.querySelector('.hjd-analyse-btn')) return;

  const btn = createButton(gameId);

  // Try to place near Lichess's own analysis/rematch buttons
  const controlsBar = document.querySelector('.game__control .rcontrols')
    || document.querySelector('.game__control')
    || document.querySelector('.analyse__controls .features')
    || document.querySelector('.analyse__controls');

  if (controlsBar) {
    controlsBar.appendChild(btn);
  } else {
    // Fallback: float in bottom-right corner
    btn.classList.add('hjd-analyse-btn--floating');
    document.body.appendChild(btn);
  }
}

// Inject on load
injectButton();

// Re-inject on Lichess SPA navigation (Lichess uses turbo/barba.js-style page transitions)
const observer = new MutationObserver(() => {
  // Debounce: only check when URL has likely changed
  if (!document.querySelector('.hjd-analyse-btn')) {
    injectButton();
  }
});

observer.observe(document.body, { childList: true, subtree: true });
