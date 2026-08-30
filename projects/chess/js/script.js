// Chess Analysis Script - Updated Version with Eval Graph and Engine Control
// Constants
const BOARD_SIZE = 500;
const SQUARE_SIZE = BOARD_SIZE / 8;
const ANALYSIS_DEPTH = 18;
const MULTI_PV_LINES = 3;
const GRAPH_DEPTH = 22;
const EVAL_CACHE_MAX = 2000;
const GRAPH_REDRAW_MS = 250; // min interval between chart repaints during the graph pass

// Graph worker pool — several small workers beat one big-threaded worker
// because separate positions parallelise perfectly while SMP inside a single
// search scales sublinearly (especially at small node budgets).
const GRAPH_POOL_SIZE = 4;
const GRAPH_POOL_THREADS = 2; // per worker; single-threaded builds ignore this cleanly
const GRAPH_POOL_HASH_MB = 32;
// Pool workers boot in two stages (see ensureGraphPool). The first one does the
// real ~79MB download on a cold cache and gets a budget sized for a slow link;
// the rest start from the HTTP cache and only need enough to compile the net.
const GRAPH_POOL_FIRST_INIT_TIMEOUT_MS = 120000;
const GRAPH_POOL_INIT_TIMEOUT_MS = 45000;
const GRAPH_POOL_LAST_RESORT_TIMEOUT_MS = 240000; // solo attempt before giving up entirely
const GRAPH_POOL_WARM_BOOT_MS = 15000;   // a boot slower than this, AFTER one already pulled the
                                         // net, means HTTP caching isn't helping (warm ≈ 1.3-5s)
const GRAPH_STALL_TIMEOUT_MS = 90000;     // no task completing for this long = the pass is wedged
const GRAPH_POOL_ENGINE = 'full';    // same net as live analysis — evals/classifications match
const GRAPH_SKETCH_NODES = 12000;    // sketch tasks: provisional curve, fully overwritten by polish
const GRAPH_POLISH_NODES = 600000;   // uniform polish budget (≈ d18-20, full net) — uniform for ALL
                                     // positions: classifications are deltas between adjacent evals,
                                     // so mixed budgets systematically soften/flip badges
const GRAPH_SKIP_DEPTH = 18;         // a result is final at depth ≥ this (or full polish budget) — matches live-engine depth so its results (e.g. the start position) are reused, keeping neighbour evals at uniform quality

// Multi-threaded engines need SharedArrayBuffer, which needs cross-origin
// isolation (COOP/COEP headers). chess.hjd.ai serves them; GitHub Pages can't,
// so it falls back to the single-threaded builds automatically.
const THREADS_SUPPORTED = typeof SharedArrayBuffer !== 'undefined' && !!self.crossOriginIsolated;
const ENGINE_THREADS = THREADS_SUPPORTED
  ? Math.min(Math.max((navigator.hardwareConcurrency || 4) - 2, 1), 8)
  : 1;
const ENGINE_HASH_MB = THREADS_SUPPORTED ? 256 : 128;

// Move classification thresholds (in centipawns)
const MOVE_CLASSIFICATION = {
  BRILLIANT: { symbol: '!!', color: '#1baca6', minGain: 150 }, // Gains 1.5+ pawns unexpectedly
  GREAT: { symbol: '!', color: '#5c8bb0', maxLoss: 0, minGain: 50 }, // Gains 0.5+ pawns
  GOOD: { symbol: '', color: '#96bc4b', maxLoss: 10 }, // Loses less than 0.1 pawn
  INACCURACY: { symbol: '?!', color: '#f7c631', maxLoss: 50 }, // Loses 0.1-0.5 pawns
  MISTAKE: { symbol: '?', color: '#e6912c', maxLoss: 150 }, // Loses 0.5-1.5 pawns
  BLUNDER: { symbol: '??', color: '#ca3431', maxLoss: Infinity } // Loses 1.5+ pawns
};

// Engine configurations — threaded SF 17.1 builds when isolated, single-threaded SF 17 otherwise
// (filenames are content-hashed as shipped; the loader derives its .wasm path from its own URL)
const ENGINES = THREADS_SUPPORTED ? {
  lite: {
    name: 'Stockfish 17.1 Lite',
    script: 'js/stockfish-17.1-lite-51f59da.js'
  },
  full: {
    name: 'Stockfish 17.1',
    script: 'js/stockfish-17.1-8e4d048.js'
  }
} : {
  lite: {
    name: 'Stockfish 17 Lite',
    script: 'js/stockfish-17-lite-single.js'
  },
  full: {
    name: 'Stockfish 17',
    script: 'js/stockfish-17-single.js'
  }
};

// Application state
const AppState = {
  board: null,
  game: null,
  stockfish: null,
  multipvResults: {},
  bestMoveInfo: null,
  pgnMainlineMoves: [],
  userMoves: [],
  currentIndex: 0,
  lastFen: '',
  isAnalysisInProgress: false,
  stockfishReady: false,
  arrowsEnabled: true,
  gameLoaded: false,
  engineEnabled: true, // New state for engine toggle
  selectedEngine: 'lite', // Current engine selection
  preloadedFullEngine: null, // Preloaded full engine worker
  gameStatus: 'ongoing', // 'ongoing', 'checkmate', 'draw'
  checkmateWinner: null, // 'white', 'black', or null
  isInCheck: false,
  promotionPending: false,
  promotionMove: null, // Stores the pending promotion move
  promotionCallback: null, // Callback function to execute after promotion choice
  // Chart.js eval graph
  evalChart: null, // Chart.js instance
  graphMainlineMoves: [], // Original PGN moves for graph display only
  graphEvalHistory: [],
  moveClassifications: [], // Store classification for each move (index = move number)
  graphDrawn: false, // Whether the graph has been drawn (user clicked Draw button)
  // Analysis queue system - prevents engine crashes
  currentAnalysisId: 0,        // Increments for each request
  activeAnalysisId: null,      // The analysis currently running
  pendingAnalysisFen: null,    // FEN waiting to be analyzed  
  pendingAnalysisId: null,     // ID of the pending analysis
  engineBusy: false,           // Is the engine currently searching?
  stopRequested: false,        // Have we sent 'stop' and waiting for bestmove?
  // Performance caches
  fenCache: [],                  // FEN per position for O(1) navigation
  evalCache: new Map(),          // FEN → {multipvResults, bestMoveInfo, depth, lines} — never re-search a known position
  activeAnalysisFen: null,       // FEN of the analysis currently running (for cache writes)
  _liveDisplayScheduled: false,  // rAF coalescing flag for live analysis display updates
  cachedAccuracy: null,          // Cached { white, black } accuracy
  cachedAccuracyLength: 0,       // Eval count when accuracy was last computed
  notationDirty: true,           // Whether notation needs re-render
  graphPool: [],                 // Parallel graph analysis workers (kept warm between games)
  _graphWorkers: new Set(),      // EVERY live pool worker, tracked from birth — including ones
                                 // still initialising, so a cancel can terminate them too
  _graphPoolPromise: null,       // In-flight ensureGraphPool(), so two loads share one init
  _graphPoolAborts: new Set(),   // Rejectors for inits still waiting on 'readyok', so a cancel
                                 // settles them now instead of leaving them to time out
  _graphPoolGen: 0,              // Bumped when the pool is destroyed; init results from an
                                 // older generation are terminated instead of adopted
  _graphRunId: 0,                // Bumped to cancel an in-flight graph run
  _graphRunActive: false,        // A graph pass is currently running
  _graphPixelCache: null,        // Per-index pixel coords on the eval chart (for the dot overlay)
  _fullEnginePreloading: false,  // True while preloadFullEngine() worker is loading
  hasLoadedOnce: false,          // Skip init timeout on first load
  _lastArrowKey: '',             // Arrow fingerprint for skip-redraw optimisation
  // Tablebase
  tablebaseCache: new Map(),     // FEN → Syzygy tablebase API result
  isTablebasePosition: false,    // Whether current position uses tablebase
  // Sideline tracking
  inSideline: false,             // Whether current position is on a sideline
  sidelineBranchIndex: -1,       // currentIndex value at the branch point
  sidelineMoves: []              // Moves played in the sideline (from branch point)
};

// Initialize the application
function initializeApp() {
  // Initialize Chess.js game
  AppState.game = new Chess();
  
  // Initialize Stockfish
  initializeStockfish();
  
  // Check URL parameters before board init
  const urlParams = new URLSearchParams(window.location.search);
  const gameParam = urlParams.get('game');
  const colorParam = urlParams.get('color');

  // Initialize board with configuration
  const config = {
    draggable: true,
    position: 'start',
    orientation: colorParam === 'black' ? 'black' : 'white',
    dropOffBoard: 'snapback',
    sparePieces: false,
    onDragStart: handleDragStart,
    onDrop: handleDrop,
    onSnapEnd: handleSnapEnd
  };

  AppState.board = Chessboard('myBoard', config);

  // Cache frequently-accessed DOM elements
  const arrowsCanvas = document.getElementById('arrows-overlay');
  const evalGraph = document.getElementById('analysis-eval-graph');
  AppState._els = {
    evalBar: document.getElementById('eval-bar'),
    arrowsCanvas: arrowsCanvas,
    arrowsCtx: arrowsCanvas.getContext('2d'),
    evalGraph: evalGraph,
    stockfishLoading: document.getElementById('stockfish-loading'),
    pgnInput: document.getElementById('pgn-input'),
  };

  // Dropdown labels reflect the runtime-selected builds (threaded vs single)
  const engineSelect = document.getElementById('engine-select');
  if (engineSelect) {
    Object.keys(ENGINES).forEach(key => {
      const opt = engineSelect.querySelector(`option[value="${key}"]`);
      if (opt) opt.textContent = ENGINES[key].name;
    });
  }

  // Set up event listeners
  setupEventListeners();

  // Initialize viewport scaling + settings panel
  loadZoomPreference();
  initSettingsPanel();
  updateViewportScale();

  // Initialize Chart.js eval graph
  initEvalChart();

  // Fetch Lichess game if ID provided (?game=AbCdEfGh&color=black)
  if (gameParam) {
    fetchLichessGame(gameParam);
  }
}

// Shared UCI options for every worker (live, preloaded, graph)
function sendEngineOptions(worker) {
  worker.postMessage('setoption name Threads value ' + ENGINE_THREADS);
  worker.postMessage('setoption name Hash value ' + ENGINE_HASH_MB);
}

// Bank a finished analysis so this position is never searched again this session
function cacheAnalysisResult(fen, multipvResults, bestMoveInfo, depth) {
  if (!fen || typeof depth !== 'number' || depth <= 0) return;
  const lines = Object.keys(multipvResults).length;
  if (lines === 0) return;
  const existing = AppState.evalCache.get(fen);
  if (existing && (existing.depth > depth || (existing.depth === depth && existing.lines >= lines))) return;
  // Drop `fen` FIRST: on a sketch→polish depth upgrade the key is already
  // present, and evicting before the delete threw out an unrelated entry to
  // make room for one that needed none.
  AppState.evalCache.delete(fen); // refresh insertion order
  if (AppState.evalCache.size >= EVAL_CACHE_MAX) {
    AppState.evalCache.delete(AppState.evalCache.keys().next().value); // drop oldest
  }
  AppState.evalCache.set(fen, { multipvResults, bestMoveInfo, depth, lines });
}

// Stockfish initialization
function initializeStockfish() {
  // Reset analysis state
  AppState.engineBusy = false;
  AppState.stopRequested = false;
  AppState.activeAnalysisId = null;
  AppState.pendingAnalysisFen = null;
  AppState.pendingAnalysisId = null;
  AppState.currentAnalysisId = 0;
  
  try {
    const engineScript = ENGINES[AppState.selectedEngine].script;
    AppState.stockfish = new Worker(engineScript);
    
    // Add error handler for the worker
    AppState.stockfish.onerror = function(error) {
      console.error('Stockfish worker error:', error);
      document.getElementById('stockfish-loading').style.display = 'none';
      
      // Automatically disable the engine
      if (AppState.engineEnabled) {
        document.getElementById('engine-toggle').checked = false;
        AppState.engineEnabled = false;
      }
    };
    
    // Add timeout protection - NOT ON FIRST LOADUP
    let initTimeout = null;

    if (AppState.hasLoadedOnce) {
      // Enforce timeout ONLY if this is not the first load
      initTimeout = setTimeout(() => {
        console.error('Stockfish initialization timeout');
        document.getElementById('stockfish-loading').style.display = 'none';

        if (AppState.engineEnabled) {
          document.getElementById('engine-toggle').checked = false;
          AppState.engineEnabled = false;
        }
      }, 10000); // 10 second timeout
    }
    
    AppState.stockfish.onmessage = function(event) {
      // Clear timeout on first message
      if (initTimeout) {
        clearTimeout(initTimeout);
        initTimeout = null;
      }
      handleStockfishMessage(event);
    };
    
    AppState.stockfish.postMessage('uci');
    sendEngineOptions(AppState.stockfish);
    AppState.stockfish.postMessage('setoption name MultiPV value ' + MULTI_PV_LINES);
    AppState.stockfish.postMessage('isready');
    
  } catch (error) {
    console.error('Failed to initialize Stockfish:', error);
    document.getElementById('stockfish-loading').style.display = 'none';
    showError('Failed to load chess engine. Please refresh the page.');
  }
}

// Enhanced game status detection that also checks PGN results
function updateGameStatus() {
  const game = AppState.game;
  
  // Reset status
  AppState.gameStatus = 'ongoing';
  AppState.checkmateWinner = null;
  AppState.isInCheck = game.in_check();
  
  // First check if game is over by position
  if (game.game_over()) {
    if (game.in_checkmate()) {
      AppState.gameStatus = 'checkmate';
      // The player who just moved delivered checkmate
      AppState.checkmateWinner = game.turn() === 'w' ? 'black' : 'white';
    } else {
      // All other positional game endings are draws
      AppState.gameStatus = 'draw';
    }
  }
  // Also check if we're at the end of a loaded PGN with a result
  else if (AppState.gameLoaded && AppState.currentIndex >= AppState.pgnMainlineMoves.length) {
    // Try to get the PGN result from the original PGN text
    const pgnEl = document.getElementById('pgn-input');
    const pgnText = (pgnEl.dataset.pgn || pgnEl.value).trim();
    if (pgnText) {
      // Look for game result at the end of PGN
      if (pgnText.includes('1-0')) {
        AppState.gameStatus = 'checkmate';
        AppState.checkmateWinner = 'white';
      } else if (pgnText.includes('0-1')) {
        AppState.gameStatus = 'checkmate';
        AppState.checkmateWinner = 'black';
      } else if (pgnText.includes('1/2-1/2') || pgnText.includes('½-½')) {
        AppState.gameStatus = 'draw';
      }
    }
  }
}

// Stockfish message handler
function handleStockfishMessage(event) {
  const message = event.data;
  
  if (message === 'readyok') {
    handleStockfishReady();
  } else if (message.startsWith('info depth')) {
    handleAnalysisInfo(message);
  } else if (message.startsWith('bestmove')) {
    handleBestMove(message);
  }
}

function handleStockfishReady() {
  console.log('Stockfish is ready!');
  AppState.stockfishReady = true;
  AppState.hasLoadedOnce = true;
  AppState.engineBusy = false;
  AppState.stopRequested = false;
  document.getElementById('stockfish-loading').style.display = 'none';

  // Preload full engine in background if we're using lite
  if (AppState.selectedEngine === 'lite' && !AppState.preloadedFullEngine) {
    setTimeout(preloadFullEngine, 1000); // Delay to not compete with initial analysis
  }

  if (AppState.engineEnabled) {
    updateStockfishAnalysis();
  }
}

function handleAnalysisInfo(message) {
  if (!AppState.stockfishReady || !AppState.engineEnabled) return;
  
  // Only accept results from active analysis
  if (AppState.activeAnalysisId !== AppState.currentAnalysisId) return;
  
  const info = parseStockfishInfo(message);
  if (!info) return;
  
  AppState.multipvResults[info.multipv] = info;

  // Coalesce display updates into one per frame — Stockfish emits dozens of
  // info lines per second and each DOM/canvas repaint above ~60fps is wasted
  scheduleLiveDisplayUpdate();
}

function scheduleLiveDisplayUpdate() {
  if (AppState._liveDisplayScheduled) return;
  AppState._liveDisplayScheduled = true;
  requestAnimationFrame(() => {
    AppState._liveDisplayScheduled = false;
    updateDisplay();
  });
}

function handleBestMove(message) {
  // Engine is no longer busy - this is the critical state transition
  AppState.engineBusy = false;
  AppState.stopRequested = false;
  AppState.isAnalysisInProgress = false;
  
  // Only process bestmove if it's for the current analysis
  const isCurrentAnalysis = AppState.activeAnalysisId === AppState.currentAnalysisId;
  
  if (isCurrentAnalysis && AppState.engineEnabled) {
    const parts = message.split(' ');
    const bestMove = parts[1];

    if (bestMove && bestMove !== '(none)') {
      AppState.bestMoveInfo = {
        bestMove: bestMove,
        ponder: parts[3] || null
      };
    }

    // Bank the completed search — revisiting this position is now free
    const top = AppState.multipvResults[1];
    if (top && typeof top.depth === 'number') {
      cacheAnalysisResult(
        AppState.activeAnalysisFen,
        Object.assign({}, AppState.multipvResults),
        AppState.bestMoveInfo,
        top.depth
      );
    }
    updateDisplay();
  }

  // CRITICAL: Check if there's a pending analysis waiting
  // This handles rapid navigation - start the queued analysis now
  if (AppState.pendingAnalysisFen && AppState.pendingAnalysisId !== null) {
    tryStartAnalysis();
  }
}

// Parse Stockfish analysis info
function parseStockfishInfo(message) {
  const parts = message.split(' ');
  const info = {
    depth: null,
    score: null,
    pv: null,
    multipv: 1,
    mate: undefined
  };
  
  for (let i = 0; i < parts.length; i++) {
    switch (parts[i]) {
      case 'depth':
        info.depth = parseInt(parts[++i], 10);
        break;
      case 'multipv':
        info.multipv = parseInt(parts[++i], 10);
        break;
      case 'cp':
        info.score = (parseInt(parts[++i], 10) / 100).toFixed(2);
        break;
      case 'mate':
        info.mate = parseInt(parts[++i], 10);
        break;
      case 'pv':
        info.pv = parts.slice(++i).join(' ');
        i = parts.length;
        break;
    }
  }
  
  if (info.depth === null || info.pv === null) return null;
  
  // Store the score from White's perspective to prevent twitching
  if (AppState.game.turn() === 'b') {
    if (info.mate !== undefined) {
      info.mate = -info.mate;
    } else if (info.score !== null) {
      info.score = (-parseFloat(info.score)).toFixed(2);
    }
  }
  
  info.scoreDisplay = info.mate !== undefined 
    ? `Mate in ${Math.abs(info.mate)}` 
    : info.score;
  
  return info;
}

// Track user move — detect sideline deviation from mainline
// Note: game.history() is unreliable after game.load(fen) (navigation clears it),
// so we track the played move directly instead of slicing history.
function _applyUserMove() {
  const history = AppState.game.history();
  const playedMove = history[history.length - 1];
  const preMoveIndex = AppState.currentIndex; // position before the new move

  if (AppState.gameLoaded) {
    const isMainlineMove = AppState.pgnMainlineMoves.length > preMoveIndex &&
      AppState.pgnMainlineMoves[preMoveIndex] === playedMove;

    if (!isMainlineMove) {
      if (AppState.inSideline && preMoveIndex >= AppState.sidelineBranchIndex) {
        // Extending or overwriting within current sideline
        const depth = preMoveIndex - AppState.sidelineBranchIndex;
        AppState.sidelineMoves = AppState.sidelineMoves.slice(0, depth);
        AppState.sidelineMoves.push(playedMove);
      } else {
        // New deviation from mainline
        AppState.inSideline = true;
        AppState.sidelineBranchIndex = preMoveIndex;
        AppState.sidelineMoves = [playedMove];
      }
    } else if (AppState.inSideline) {
      // Extending sideline (move happens to match mainline but we're off-path)
      const depth = preMoveIndex - AppState.sidelineBranchIndex;
      AppState.sidelineMoves = AppState.sidelineMoves.slice(0, depth);
      AppState.sidelineMoves.push(playedMove);
    }
  } else {
    // Free analysis (no PGN) — history is reliable here
    AppState.userMoves = history;
  }

  AppState.currentIndex = preMoveIndex + 1;
  AppState.notationDirty = true;

  updateGameStatus();
  if (AppState.engineEnabled) updateStockfishAnalysis();
  updateDisplay();
}

// Board event handlers
function handleDragStart(source, piece, position, orientation) {
  
  if (AppState.game.game_over()) return false;
  
  // Only allow the side to move
  const turn = AppState.game.turn();
  if ((turn === 'w' && piece.search(/^b/) !== -1) ||
      (turn === 'b' && piece.search(/^w/) !== -1)) {
    return false;
  }
  
  return true;
}

function handleDrop(source, target) {

  // Check if this is a promotion move
  const piece = AppState.game.get(source);
  const isPawn = piece && piece.type === 'p';
  const isPromotionRank = (piece && piece.color === 'w' && target[1] === '8') || 
                         (piece && piece.color === 'b' && target[1] === '1');
  
  if (isPawn && isPromotionRank) {
    // This is a promotion move - show promotion grid
    AppState.promotionMove = { from: source, to: target };
    AppState.promotionPending = true;
    showPromotionGrid(piece.color);
    return 'drop'; // Allow the visual drop, we'll handle the actual move after promotion choice
  }
  
  // Regular move (not promotion)
  const move = AppState.game.move({
    from: source,
    to: target
  });
  
  if (move === null) return 'snapback';
  
  _applyUserMove();
  return 'drop';
}

function handleSnapEnd() {
  AppState.board.position(AppState.game.fen());
}

// Stockfish analysis update - queue-based to prevent crashes
function updateStockfishAnalysis() {
  if (!AppState.engineEnabled || !AppState.stockfish || !AppState.stockfishReady) {
    return;
  }
  
  // Increment analysis ID
  AppState.currentAnalysisId++;
  const requestId = AppState.currentAnalysisId;
  const fen = AppState.game.fen();
  
  // Queue this request
  AppState.pendingAnalysisFen = fen;
  AppState.pendingAnalysisId = requestId;
  
  // Try to start (may queue if engine is busy)
  tryStartAnalysis();
}

function tryStartAnalysis() {
  if (!AppState.pendingAnalysisFen || AppState.pendingAnalysisId === null) {
    return;
  }

  if (!AppState.engineEnabled) return;

  const fen = AppState.pendingAnalysisFen;
  const analysisId = AppState.pendingAnalysisId;

  // Tablebase path — ≤7 pieces, mathematically solved
  if (countPieces(fen) <= 7) {
    AppState.pendingAnalysisFen = null;
    AppState.pendingAnalysisId = null;
    AppState.activeAnalysisId = analysisId;
    AppState.lastFen = fen;
    AppState.isTablebasePosition = true;
    AppState.isAnalysisInProgress = true;
    AppState.multipvResults = {};
    AppState.bestMoveInfo = null;

    queryTablebase(fen).then(tb => {
      if (AppState.activeAnalysisId !== analysisId) return;
      if (tb) {
        handleTablebaseResult(tb, fen);
      } else {
        // API failed — fall back to Stockfish
        AppState.isTablebasePosition = false;
        AppState.pendingAnalysisFen = fen;
        AppState.pendingAnalysisId = analysisId;
        tryStartAnalysis();
      }
    });
    return;
  }

  AppState.isTablebasePosition = false;

  // Cache path — serve work the engine has already done for this position.
  // NOTE: activeAnalysisId is deliberately NOT set to analysisId here; any
  // still-running search keeps a stale id, so its late info/bestmove messages
  // are rejected and can't overwrite the cached result we just painted.
  const cached = AppState.evalCache.get(fen);
  if (cached) {
    AppState.lastFen = fen;
    AppState.multipvResults = Object.assign({}, cached.multipvResults);
    AppState.bestMoveInfo = cached.bestMoveInfo;

    if (cached.depth >= ANALYSIS_DEPTH && cached.lines >= MULTI_PV_LINES) {
      // Full hit — nothing to compute; stop any stale search still burning CPU
      AppState.pendingAnalysisFen = null;
      AppState.pendingAnalysisId = null;
      AppState.activeAnalysisId = null;
      AppState.activeAnalysisFen = null;
      AppState.isAnalysisInProgress = false;
      if (AppState.engineBusy && AppState.stockfish && !AppState.stopRequested) {
        AppState.stopRequested = true;
        try { AppState.stockfish.postMessage('stop'); } catch (e) {}
      }
      updateDisplay();
      return;
    }
    // Partial hit (graph prefetch: 1 deep line) — paint instantly, refine below
    updateDisplay();
  }

  // Stockfish path — needs engine ready
  if (!AppState.stockfish || !AppState.stockfishReady) return;

  // If engine is busy, send stop and wait for bestmove
  if (AppState.engineBusy) {
    if (!AppState.stopRequested) {
      AppState.stopRequested = true;
      try {
        AppState.stockfish.postMessage('stop');
      } catch (e) {
        console.error('Error sending stop:', e);
        AppState.engineBusy = false;
        AppState.stopRequested = false;
      }
    }
    return; // Wait for bestmove before starting new analysis
  }

  // Engine is free - start analysis
  // Clear pending state
  AppState.pendingAnalysisFen = null;
  AppState.pendingAnalysisId = null;

  // Mark as active
  AppState.activeAnalysisId = analysisId;
  AppState.activeAnalysisFen = fen;
  AppState.engineBusy = true;
  AppState.isAnalysisInProgress = true;
  AppState.lastFen = fen;

  // Keep old eval for UI stability. Cache-restored lines belong to THIS
  // position, so keep all of them — incoming results overwrite per line.
  if (!cached) {
    const oldEval = AppState.multipvResults[1];
    AppState.multipvResults = {};
    if (oldEval) {
      AppState.multipvResults[1] = oldEval;
    }
    AppState.bestMoveInfo = null;
  }

  try {
    AppState.stockfish.postMessage(`position fen ${fen}`);
    AppState.stockfish.postMessage(`go depth ${ANALYSIS_DEPTH}`);
  } catch (e) {
    console.error('Error starting analysis:', e);
    AppState.engineBusy = false;
    AppState.isAnalysisInProgress = false;
  }
}

// Display update functions
function updateMaterialScore() {
  const el = document.getElementById('material-score');
  if (!el) return;
  const fen = AppState.game.fen();
  const placement = fen.split(' ')[0];
  const values = { q: 9, r: 5, b: 3, n: 3, p: 1 };
  let score = 0;
  for (const ch of placement) {
    const lower = ch.toLowerCase();
    if (values[lower]) score += ch === lower ? -values[lower] : values[lower];
  }
  const oriented = AppState.board.orientation() === 'black' ? -score : score;
  if (oriented > 0) el.textContent = '+' + oriented;
  else if (oriented < 0) el.textContent = '\u2212' + Math.abs(oriented);
  else el.textContent = '';
}

function updateDisplay() {
  updateMaterialScore();
  updateAnalysisOutput();
  updateEvaluationBar();
  if (AppState.arrowsEnabled && AppState.engineEnabled) {
    updateBoardArrows();
  } else {
    // Clear arrows if disabled
    const canvas = AppState._els.arrowsCanvas;
    AppState._els.arrowsCtx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function updateAnalysisOutput() {
  const outputDiv = document.getElementById('stockfish-output');

  // Create stable containers once — avoids full DOM rebuild on every Stockfish message
  if (!outputDiv.querySelector('#ao-status')) {
    outputDiv.innerHTML = '';
    ['ao-status', 'ao-engine', 'ao-notation', 'ao-progress'].forEach(id => {
      const div = document.createElement('div');
      div.id = id;
      outputDiv.appendChild(div);
    });
  }

  // Status section — only changes on navigation
  updateStatusSection();

  // Engine section — updates on every Stockfish message (hot path)
  updateEngineSection();

  // Notation — only rebuild when dirty (navigation, PGN load, classification change)
  if (AppState.notationDirty) {
    renderNotation();
    AppState.notationDirty = false;
  }

  // Progress indicator
  updateProgressSection();
}

function updateStatusSection() {
  const container = document.getElementById('ao-status');
  if (!container) return;

  if (AppState.gameStatus !== 'ongoing') {
    let statusText = '';
    let statusStyles = 'padding: 12px; border-radius: 5px; margin-bottom: 10px; text-align: center; font-weight: bold; font-size: 14px; ';

    switch (AppState.gameStatus) {
      case 'checkmate':
        if (AppState.checkmateWinner === 'white') {
          statusText = 'WHITE WIN';
          statusStyles += 'color: black; background-color: white; border: 2px solid #333;';
        } else {
          statusText = 'BLACK WIN';
          statusStyles += 'color: white; background-color: black;';
        }
        break;
      case 'draw':
        statusText = 'DRAW';
        statusStyles += 'color: white; background-color: #6c757d;';
        break;
    }

    container.style.cssText = statusStyles;
    container.textContent = statusText;
  } else {
    container.style.cssText = '';
    container.textContent = '';
  }
}

function _ensureEngineSectionDOM(container) {
  if (container.querySelector('#engine-best-move')) return;
  container.innerHTML = '';

  // Best move display
  const bestMoveDiv = document.createElement('div');
  bestMoveDiv.id = 'engine-best-move';
  bestMoveDiv.style.cssText = 'font-weight: bold; margin-bottom: 5px;';
  container.appendChild(bestMoveDiv);

  // MultiPV lines container
  const linesContainer = document.createElement('div');
  linesContainer.id = 'engine-lines';
  linesContainer.style.cssText = 'height: 168px; overflow: hidden;';

  for (let lineNum = 1; lineNum <= MULTI_PV_LINES; lineNum++) {
    const lineDiv = document.createElement('div');
    lineDiv.id = `engine-line-${lineNum}`;
    lineDiv.style.cssText = 'height: 54px; font-size: 13px; overflow: hidden;';
    linesContainer.appendChild(lineDiv);

    if (lineNum < MULTI_PV_LINES) {
      const hr = document.createElement('hr');
      hr.style.cssText = 'border: none; border-top: 1px solid #eee; margin: 2px 0;';
      linesContainer.appendChild(hr);
    }
  }
  container.appendChild(linesContainer);

  // Disabled state message
  const disabledDiv = document.createElement('div');
  disabledDiv.id = 'engine-disabled';
  disabledDiv.style.cssText = 'color: #dc3545; background-color: #f8d7da; padding: 10px; border-radius: 3px; margin-bottom: 10px; display: none;';
  disabledDiv.textContent = 'Engine is disabled. Toggle on to resume analysis.';
  container.appendChild(disabledDiv);
}

function updateEngineSection() {
  const container = document.getElementById('ao-engine');
  if (!container) return;

  _ensureEngineSectionDOM(container);

  const bestMoveEl = container.querySelector('#engine-best-move');
  const linesEl = container.querySelector('#engine-lines');
  const disabledEl = container.querySelector('#engine-disabled');

  if (AppState.engineEnabled) {
    bestMoveEl.style.display = '';
    linesEl.style.display = '';
    disabledEl.style.display = 'none';

    if (AppState.isTablebasePosition && AppState.bestMoveInfo?.tablebase) {
      const tb1 = AppState.multipvResults[1];
      const categoryColor = tb1 && parseFloat(tb1.score) > 0 ? '#1baca6' : tb1 && parseFloat(tb1.score) < 0 ? '#ca3431' : '#6c757d';
      bestMoveEl.innerHTML = `<span style="background:${categoryColor};color:white;padding:2px 6px;border-radius:3px;font-size:11px;margin-right:6px;">TABLEBASE</span>Best Move: ${AppState.bestMoveInfo.bestMove}`;
    } else {
      const bestMoveText = AppState.bestMoveInfo ? AppState.bestMoveInfo.bestMove : '...';
      bestMoveEl.textContent = `Best Move: ${bestMoveText}`;
    }

    for (let lineNum = 1; lineNum <= MULTI_PV_LINES; lineNum++) {
      const lineDiv = container.querySelector(`#engine-line-${lineNum}`);
      const info = AppState.multipvResults[lineNum];

      if (info) {
        if (info.tablebase) {
          const tbBg = parseFloat(info.score) > 0 ? '#e8f5f4' : parseFloat(info.score) < 0 ? '#fde8e8' : '#f0f0f0';
          lineDiv.style.cssText = `height: 54px; font-size: 13px; overflow: hidden; background-color: ${tbBg}; padding: 0 5px; border-radius: 3px;`;
        } else if (info.mate !== undefined) {
          lineDiv.style.cssText = `height: 54px; font-size: 13px; overflow: hidden; background-color: ${info.mate > 0 ? '#d4edda' : '#f8d7da'}; padding: 0 5px; border-radius: 3px; font-weight: bold;`;
        } else {
          lineDiv.style.cssText = 'height: 54px; font-size: 13px; overflow: hidden;';
        }
        lineDiv.textContent = `${lineNum}. Score: ${info.scoreDisplay}\nLine: ${info.pv}`;
      } else {
        lineDiv.style.cssText = 'height: 54px; font-size: 13px; overflow: hidden; color: #999;';
        lineDiv.textContent = `${lineNum}. ...`;
      }
    }
  } else {
    bestMoveEl.style.display = 'none';
    linesEl.style.display = 'none';
    disabledEl.style.display = '';
  }
}

function renderNotation() {
  const container = document.getElementById('ao-notation');
  if (!container) return;

  const hasSideline = AppState.sidelineMoves.length > 0;
  const branchIdx = AppState.sidelineBranchIndex;

  // Decide which move list to iterate for the mainline
  const mainMoves = AppState.gameLoaded ? AppState.pgnMainlineMoves : AppState.userMoves;

  let notationHTML = '<div style="margin-top: 20px; font-family: monospace;"><strong>Notation:</strong><br>';

  // "Return to mainline" button when actively in sideline
  if (AppState.inSideline) {
    notationHTML += '<div id="return-mainline-btn" class="return-mainline">\u21a9 Return to mainline</div>';
  }

  let sidelineInserted = false;

  for (let i = 0; i < mainMoves.length; i += 2) {
    const moveNumber = Math.floor(i / 2) + 1;
    const whiteMove = mainMoves[i];
    const blackMove = mainMoves[i + 1];

    notationHTML += '<div class="move-pair">';
    notationHTML += `<span class="move-number">${moveNumber}.</span> `;

    // White move
    const whiteMoveIndex = i + 1;
    const whiteDimmed = hasSideline && i >= branchIdx;
    const isWhiteCurrent = !AppState.inSideline && whiteMoveIndex === AppState.currentIndex;
    const whiteClasses = ['move-link', 'white-move', 'mainline-move'];
    if (whiteDimmed) whiteClasses.push('dimmed');
    if (isWhiteCurrent) whiteClasses.push('current');

    const whiteClassification = AppState.moveClassifications[whiteMoveIndex];
    let whiteMoveText = whiteMove;
    let whiteStyle = '';
    if (whiteClassification && whiteClassification.symbol) {
      whiteMoveText += whiteClassification.symbol;
      whiteStyle = `color: ${whiteClassification.color}; font-weight: bold;`;
    }

    notationHTML += `<span class="${whiteClasses.join(' ')}" data-move-index="${whiteMoveIndex}" style="${whiteStyle}">${whiteMoveText}</span>`;

    // Black move
    if (blackMove) {
      const blackMoveIndex = i + 2;
      const blackDimmed = hasSideline && (i + 1) >= branchIdx;
      const isBlackCurrent = !AppState.inSideline && blackMoveIndex === AppState.currentIndex;
      const blackClasses = ['move-link', 'black-move', 'mainline-move'];
      if (blackDimmed) blackClasses.push('dimmed');
      if (isBlackCurrent) blackClasses.push('current');

      const blackClassification = AppState.moveClassifications[blackMoveIndex];
      let blackMoveText = blackMove;
      let blackStyle = '';
      if (blackClassification && blackClassification.symbol) {
        blackMoveText += blackClassification.symbol;
        blackStyle = `color: ${blackClassification.color}; font-weight: bold;`;
      }

      notationHTML += ` <span class="${blackClasses.join(' ')}" data-move-index="${blackMoveIndex}" style="${blackStyle}">${blackMoveText}</span>`;
    }

    notationHTML += '</div>';

    // Insert sideline block after the move pair containing the branch point
    if (hasSideline && !sidelineInserted) {
      const pairEnd = blackMove ? i + 2 : i + 1;
      if (branchIdx <= pairEnd) {
        notationHTML += renderSidelineBlock();
        sidelineInserted = true;
      }
    }
  }

  // Game result
  if (AppState.gameStatus === 'checkmate') {
    notationHTML += AppState.checkmateWinner === 'white' ? ' <strong>1-0</strong>' : ' <strong>0-1</strong>';
  } else if (AppState.gameStatus === 'draw') {
    notationHTML += ' <strong>\u00bd-\u00bd</strong>';
  }

  notationHTML += '</div>';
  container.innerHTML = notationHTML;
}

function renderSidelineBlock() {
  const moves = AppState.sidelineMoves;
  const branchIdx = AppState.sidelineBranchIndex;
  if (!moves.length) return '';

  let html = '<div class="sideline-block"><span class="sideline-prefix">\u21b3</span>';

  for (let j = 0; j < moves.length; j++) {
    const globalHalfMove = branchIdx + j; // 0-based half-move index of this move
    const moveNum = Math.floor(globalHalfMove / 2) + 1;
    const isWhite = globalHalfMove % 2 === 0;

    // Show move number for white moves or the very first sideline move
    if (isWhite || j === 0) {
      html += `<span class="move-number">${moveNum}${isWhite ? '.' : '...'}</span> `;
    }

    const sidelineMoveIndex = branchIdx + j + 1; // matches currentIndex convention
    const isCurrent = AppState.inSideline && sidelineMoveIndex === AppState.currentIndex;
    const classes = ['move-link', 'sideline-move'];
    if (isCurrent) classes.push('current');

    html += `<span class="${classes.join(' ')}" data-move-index="${sidelineMoveIndex}">${moves[j]}</span> `;
  }

  html += '</div>';
  return html;
}

function updateProgressSection() {
  const container = document.getElementById('ao-progress');
  if (!container) return;

  if (AppState.isAnalysisInProgress && AppState.engineEnabled) {
    container.style.cssText = 'margin-top: 10px; color: #856404; background-color: #fff3cd; padding: 5px; border-radius: 3px;';
    container.textContent = 'Analysis in progress...';
  } else {
    container.style.cssText = '';
    container.textContent = '';
  }
}

function updateEvaluationBar() {
  if (!AppState.multipvResults[1]) return;

  const entry = AppState.multipvResults[1];
  const evalBar = AppState._els.evalBar;
  const isFlipped = AppState.board.orientation() === 'black';

  let effectiveEval;
  if (entry.mate !== undefined) {
    effectiveEval = (entry.mate > 0) ? 10 : -10;
  } else {
    effectiveEval = parseFloat(entry.score);
    effectiveEval = Math.max(-10, Math.min(10, effectiveEval));
  }

  const whitePercentage = ((effectiveEval + 10) / 20) * 100;

  // Gradient direction depends on board orientation
  if (whitePercentage <= 0) {
    evalBar.style.background = 'black';
  } else if (whitePercentage >= 100) {
    evalBar.style.background = 'white';
  } else {
    const direction = isFlipped ? 'to bottom' : 'to top';
    evalBar.style.background = `linear-gradient(${direction}, white ${whitePercentage}%, black ${whitePercentage}%)`;
  }

  // Eval score overlay — clamp centipawn display to ±10.00 (matches bar visual)
  let evalText;
  if (entry.mate !== undefined) {
    evalText = 'M' + Math.abs(entry.mate);
  } else {
    const raw = parseFloat(entry.score);
    evalText = Math.max(-10, Math.min(10, raw)).toFixed(2);
  }

  let overlay = AppState._els.evalOverlay;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'eval-overlay';
    overlay.style.cssText = 'position: absolute; bottom: 0; width: 100%; text-align: center; pointer-events: none; font-family: monospace; font-size: 10px;';
    evalBar.appendChild(overlay);
    AppState._els.evalOverlay = overlay;
  }

  const textColor = isFlipped
    ? (whitePercentage >= 100 ? 'black' : 'white')
    : (whitePercentage > 0 ? 'black' : 'white');

  overlay.style.color = textColor;
  overlay.textContent = evalText;
}

// Arrow drawing functions
function updateBoardArrows() {
  const canvas = AppState._els.arrowsCanvas;
  const ctx = AppState._els.arrowsCtx;
  const isFlipped = AppState.board.orientation() === 'black';

  // Compute lightweight fingerprint of current arrow state
  const arrowKey = Object.keys(AppState.multipvResults).length === 0 || !AppState.engineEnabled
    ? ''
    : Object.keys(AppState.multipvResults)
        .sort()
        .map(k => AppState.multipvResults[k]?.pv?.split(' ')[0] || '')
        .join(',') + (isFlipped ? ':b' : ':w');

  // Skip redraw if arrows haven't changed
  if (arrowKey === AppState._lastArrowKey) return;
  AppState._lastArrowKey = arrowKey;

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!arrowKey) return;

  // Define drawing styles for each MultiPV index
  const styles = {
    1: { lineWidth: 8, alpha: 1 },
    2: { lineWidth: 5, alpha: 0.6 },
    3: { lineWidth: 3, alpha: 0.4 }
  };

  const sortedKeys = Object.keys(AppState.multipvResults).sort((a, b) => a - b);
  sortedKeys.forEach(key => {
    const pv = AppState.multipvResults[key].pv;
    if (!pv) return;
    const moves = pv.split(' ');
    if (moves.length === 0) return;
    const move = moves[0];
    if (move.length < 4) return;
    const from = move.substring(0, 2);
    const to = move.substring(2, 4);
    const style = styles[key] || { lineWidth: 4, alpha: 0.7 };
    drawArrow(ctx, from, to, style.lineWidth, style.alpha, isFlipped);
  });
}

function drawArrow(ctx, from, to, lineWidth, alpha, isFlipped) {
  const startPos = getSquareCenter(from, isFlipped);
  const endPos = getSquareCenter(to, isFlipped);
  
  const headLength = 16; // Length of the arrowhead (along the arrow direction)
  const dx = endPos.x - startPos.x;
  const dy = endPos.y - startPos.y;
  const angle = Math.atan2(dy, dx);

  // Compute the midpoint of the arrowhead's base.
  const cosOffset = Math.cos(Math.PI / 6); // ≈ 0.8660
  const baseMid = {
    x: endPos.x - headLength * cosOffset * Math.cos(angle),
    y: endPos.y - headLength * cosOffset * Math.sin(angle)
  };

  // Set the drawing color to blue with the provided opacity.
  const color = `rgba(0, 0, 255, ${alpha})`;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;

  // Draw the main line from "from" to the base midpoint.
  ctx.beginPath();
  ctx.moveTo(startPos.x, startPos.y);
  ctx.lineTo(baseMid.x, baseMid.y);
  ctx.stroke();

  // Compute the two base corners of the arrowhead using ±30° offsets.
  const offsetAngle = Math.PI / 6; // 30 degrees
  const baseLeft = {
    x: endPos.x - headLength * Math.cos(angle - offsetAngle),
    y: endPos.y - headLength * Math.sin(angle - offsetAngle)
  };
  const baseRight = {
    x: endPos.x - headLength * Math.cos(angle + offsetAngle),
    y: endPos.y - headLength * Math.sin(angle + offsetAngle)
  };

  // Draw the arrowhead as a filled triangle.
  ctx.beginPath();
  ctx.moveTo(endPos.x, endPos.y);         // Tip of the arrow
  ctx.lineTo(baseLeft.x, baseLeft.y);
  ctx.lineTo(baseRight.x, baseRight.y);
  ctx.closePath();
  ctx.fill();
}

function getSquareCenter(square, isFlipped) {
  const file = square.charCodeAt(0) - 'a'.charCodeAt(0);
  const rank = parseInt(square[1], 10) - 1;
  if (isFlipped === undefined) isFlipped = AppState.board.orientation() === 'black';

  const x = (isFlipped ? 7 - file : file) * SQUARE_SIZE + SQUARE_SIZE / 2;
  const y = (isFlipped ? rank : 7 - rank) * SQUARE_SIZE + SQUARE_SIZE / 2;
  
  return { x, y };
}

// Preload full engine in background
function preloadFullEngine() {
  if (AppState.preloadedFullEngine || AppState._fullEnginePreloading) return;

  AppState._fullEnginePreloading = true;

  try {
    const worker = new Worker(ENGINES.full.script);

    worker.onmessage = function(e) {
      if (e.data === 'uciok') {
        console.log('Full Stockfish engine preloaded and ready');
        worker.postMessage('isready');
      } else if (e.data === 'readyok') {
        AppState._fullEnginePreloading = false;
        AppState.preloadedFullEngine = worker;
      }
    };

    worker.onerror = function(error) {
      console.error('Error preloading full engine:', error);
      AppState._fullEnginePreloading = false;
    };

    worker.postMessage('uci');
  } catch (error) {
    console.error('Failed to preload full engine:', error);
    AppState._fullEnginePreloading = false;
  }
}

// Switch to a different engine
function switchEngine(engineKey) {
  if (!ENGINES[engineKey] || engineKey === AppState.selectedEngine) return;

  console.log(`Switching engine to ${ENGINES[engineKey].name}...`);

  // Terminate existing worker
  if (AppState.stockfish) {
    try {
      AppState.stockfish.postMessage('stop');
      AppState.stockfish.terminate();
    } catch (e) {
      console.error('Error terminating old engine:', e);
    }
  }

  // Reset state
  AppState.stockfish = null;
  AppState.stockfishReady = false;
  AppState.engineBusy = false;
  AppState.stopRequested = false;
  AppState.multipvResults = {};
  AppState.bestMoveInfo = null;
  AppState.pendingAnalysisFen = null;
  AppState.pendingAnalysisId = null;

  // Update selected engine
  AppState.selectedEngine = engineKey;

  // Use preloaded full engine if available
  if (engineKey === 'full' && AppState.preloadedFullEngine) {
    console.log('Using preloaded full engine');
    AppState.stockfish = AppState.preloadedFullEngine;
    AppState.preloadedFullEngine = null;

    // Set up message handler
    AppState.stockfish.onmessage = function(event) {
      handleStockfishMessage(event);
    };
    AppState.stockfish.postMessage('ucinewgame');
    sendEngineOptions(AppState.stockfish);
    AppState.stockfish.postMessage(`setoption name MultiPV value ${MULTI_PV_LINES}`);
    AppState.stockfish.postMessage('isready');
    AppState.stockfishReady = true;
    document.getElementById('stockfish-loading').style.display = 'none';
    updateStockfishAnalysis();
    return;
  }

  // Show loading indicator
  document.getElementById('stockfish-loading').style.display = 'block';
  document.getElementById('stockfish-loading').textContent = `Loading ${ENGINES[engineKey].name}...`;

  // Initialize new engine
  initializeStockfish();
}

// Toggle engine on/off
function toggleEngine() {
  AppState.engineEnabled = !AppState.engineEnabled;
  
  if (AppState.engineEnabled) {
    if (!AppState.stockfish || !AppState.stockfishReady) {
      console.log('Recreating Stockfish worker...');
      document.getElementById('stockfish-loading').style.display = 'block';
      initializeStockfish();
    } else {
      console.log('Resuming analysis...');
      AppState.multipvResults = {};
      AppState.bestMoveInfo = null;
      AppState.pendingAnalysisFen = null;
      AppState.pendingAnalysisId = null;
      
      if (AppState.engineBusy) {
        AppState.stopRequested = true;
        AppState.stockfish.postMessage('stop');
      }
      
      updateStockfishAnalysis();
    }
  } else {
    if (AppState.stockfish && AppState.engineBusy) {
      AppState.stopRequested = true;
      try {
        AppState.stockfish.postMessage('stop');
      } catch (e) {
        console.error('Error stopping Stockfish:', e);
      }
    }
    
    AppState.pendingAnalysisFen = null;
    AppState.pendingAnalysisId = null;
    AppState.currentAnalysisId++;
    AppState.isAnalysisInProgress = false;
    
    // Clear arrows immediately
    const canvas = AppState._els.arrowsCanvas;
    AppState._els.arrowsCtx.clearRect(0, 0, canvas.width, canvas.height);
  }
  
  updateDisplay();
}

// Navigation functions

// Shared tail for all navigation — rebuild state, update UI, trigger analysis
function _applyNavigation() {
  rebuildGameFromMoves();
  updateGameStatus();
  AppState.notationDirty = true;
  updateDisplay();
  // Only the current-position dot moves during navigation — never the chart
  if (AppState.gameLoaded) drawGraphDot();
  if (AppState.engineEnabled) updateStockfishAnalysis();
}

function navigateToPreviousMove() {
  if (AppState.currentIndex <= 0) return;
  // If navigating back to or past the branch point, return to mainline
  if (AppState.inSideline && AppState.currentIndex <= AppState.sidelineBranchIndex + 1) {
    AppState.inSideline = false;
  }
  AppState.currentIndex--;
  _applyNavigation();
}

function navigateToNextMove() {
  if (AppState.inSideline) {
    // Navigate within sideline
    const sidelineEnd = AppState.sidelineBranchIndex + AppState.sidelineMoves.length;
    if (AppState.currentIndex >= sidelineEnd) return;
  } else if (AppState.pgnMainlineMoves.length > 0 &&
      AppState.currentIndex < AppState.pgnMainlineMoves.length) {
    // Follow mainline — no need to mutate userMoves
  } else {
    return;
  }
  AppState.currentIndex++;
  _applyNavigation();
}

function navigateToMove(targetIndex) {
  const maxIndex = AppState.inSideline
    ? AppState.sidelineBranchIndex + AppState.sidelineMoves.length
    : AppState.pgnMainlineMoves.length || AppState.userMoves.length;
  if (targetIndex < 0 || targetIndex > maxIndex) return;
  AppState.currentIndex = targetIndex;
  _applyNavigation();
}

function navigateToStart() {
  if (AppState.currentIndex === 0) return;
  AppState.inSideline = false;
  AppState.currentIndex = 0;
  _applyNavigation();
}

function _returnToMainline() {
  AppState.inSideline = false;
  AppState.currentIndex = AppState.sidelineBranchIndex;
  _applyNavigation();
}

// Chart.js eval graph — initialisation
function initEvalChart() {
  const canvas = AppState._els.evalGraph;
  if (!canvas) return;

  // Plugin: accuracy text overlay
  const accuracyOverlay = {
    id: 'accuracyOverlay',
    afterDraw(chart) {
      if (!AppState.gameLoaded || !AppState.graphEvalHistory.some(e => e !== undefined)) return;
      const definedEvals = AppState.graphEvalHistory.filter(e => e !== undefined).length;
      if (!AppState.cachedAccuracy || definedEvals !== AppState.cachedAccuracyLength) {
        AppState.cachedAccuracy = calculateGameAccuracy();
        AppState.cachedAccuracyLength = definedEvals;
      }
      const accuracy = AppState.cachedAccuracy;
      const ctx = chart.ctx;
      const area = chart.chartArea;
      ctx.save();
      ctx.font = 'bold 12px Arial';
      ctx.fillStyle = '#000';
      if (accuracy.white !== null) {
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`${accuracy.white}%`, area.left + 5, area.top + 3);
      }
      if (accuracy.black !== null) {
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${accuracy.black}%`, area.left + 5, area.bottom - 3);
      }
      ctx.restore();
    }
  };

  // Plugin: vertical crosshair line on hover
  const crosshairPlugin = {
    id: 'crosshair',
    afterDraw(chart) {
      const active = chart.tooltip && chart.tooltip.getActiveElements();
      if (!active || active.length === 0) return;
      const x = active[0].element.x;
      const area = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.stroke();
      ctx.restore();
    }
  };

  // Plugin: dotted zero line at 0.00 eval
  const zeroLinePlugin = {
    id: 'zeroLine',
    beforeDraw(chart) {
      const yScale = chart.scales.y;
      if (!yScale) return;
      const y = yScale.getPixelForValue(0);
      const area = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.right, y);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.stroke();
      ctx.restore();
    }
  };

  AppState.evalChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          // Main eval line with dual-colour fill
          data: [],
          fill: { target: { value: 0 }, above: 'rgba(255, 255, 255, 0.95)', below: 'rgba(100, 100, 100, 0.85)' },
          borderColor: 'rgba(0, 0, 0, 0.6)',
          borderWidth: 1.5,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 0,
          pointHitRadius: 15,
          order: 2,
          spanGaps: true
        },
        {
          // Move classification markers
          data: [],
          fill: false,
          borderWidth: 0,
          showLine: false,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointBackgroundColor: [],
          pointBorderColor: [],
          pointBorderWidth: 1,
          order: 1
        }
        // NOTE: the current-position dot is NOT a dataset — it lives on the
        // #graph-dot-overlay canvas so navigation never triggers a chart update
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 6, right: 4, bottom: 6, left: 4 } },
      scales: {
        x: { display: false },
        y: { min: -12, max: 12, display: false, grid: { display: false } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          mode: 'index',
          intersect: false,
          filter: (item) => item.datasetIndex === 0,
          callbacks: {
            title: (items) => {
              if (!items.length) return '';
              const idx = items[0].dataIndex;
              if (idx === 0) return 'Start';
              const moveNum = Math.ceil(idx / 2);
              const side = idx % 2 === 1 ? '.' : '...';
              const san = AppState.graphMainlineMoves[idx - 1] || '';
              return `${moveNum}${side} ${san}`;
            },
            label: (item) => {
              const raw = AppState.graphEvalHistory[item.dataIndex];
              if (raw === undefined || raw === null) return '';
              if (Math.abs(raw) > 10) {
                const mateIn = Math.round(5 / (Math.abs(raw) - 10));
                return raw > 0 ? `#${mateIn}` : `#-${mateIn}`;
              }
              return raw > 0 ? `+${raw.toFixed(1)}` : raw.toFixed(1);
            }
          }
        }
      },
      interaction: { mode: 'index', intersect: false },
      onClick: (_event, elements) => {
        if (elements.length > 0) {
          const clickedIndex = elements[0].index;
          if (clickedIndex >= 0 && clickedIndex <= AppState.graphMainlineMoves.length) {
            AppState.inSideline = false;
            AppState.userMoves = [...AppState.graphMainlineMoves];
            navigateToMove(clickedIndex);
          }
        }
      }
    },
    plugins: [zeroLinePlugin, accuracyOverlay, crosshairPlugin]
  });

  // Overlay canvas for the current-position dot — navigation redraws only this,
  // never the chart. pointer-events:none keeps click-to-seek working underneath.
  const overlay = document.createElement('canvas');
  overlay.id = 'graph-dot-overlay';
  overlay.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;';
  canvas.parentElement.appendChild(overlay);
  AppState._els.graphDotOverlay = overlay;
}

// Cache chart pixel coords per move index — refreshed after every real chart update
function syncGraphPixelCache() {
  const chart = AppState.evalChart;
  if (!chart || !chart.scales.x || !chart.scales.y) return;
  const n = AppState.graphEvalHistory.length;
  const cache = { x: new Array(n), y: new Array(n) };
  for (let i = 0; i < n; i++) {
    cache.x[i] = chart.scales.x.getPixelForValue(i);
    const v = AppState.graphEvalHistory[i];
    cache.y[i] = v === undefined ? null : chart.scales.y.getPixelForValue(Math.max(-11, Math.min(11, v)));
  }
  AppState._graphPixelCache = cache;
}

// Draw only the current-position dot — the whole graph cost of a navigation step
function drawGraphDot() {
  const overlay = AppState._els.graphDotOverlay;
  if (!overlay) return;

  const dpr = window.devicePixelRatio || 1;
  const w = overlay.clientWidth;
  const h = overlay.clientHeight;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (overlay.width !== bw || overlay.height !== bh) {
    overlay.width = bw;
    overlay.height = bh;
  }

  const ctx = overlay.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!AppState.gameLoaded || !AppState._graphPixelCache) return;

  const cache = AppState._graphPixelCache;
  const idx = AppState.inSideline ? AppState.sidelineBranchIndex : AppState.currentIndex;
  if (idx < 0 || idx >= cache.x.length) return;
  const y = cache.y[idx];
  if (y === null || y === undefined) return;

  ctx.beginPath();
  ctx.arc(cache.x[idx], y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#FF5722';
  ctx.fill();
}

// Patch one move's classification badge in the notation without a full rebuild
function patchNotationClassification(moveIndex) {
  if (!AppState.gameLoaded) return;
  if (moveIndex < 1 || moveIndex > AppState.pgnMainlineMoves.length) return;
  const container = document.getElementById('ao-notation');
  const span = container && container.querySelector(`.mainline-move[data-move-index="${moveIndex}"]`);
  if (!span) {
    AppState.notationDirty = true; // not rendered yet — full render on next updateDisplay
    return;
  }
  const san = AppState.pgnMainlineMoves[moveIndex - 1];
  const cls = AppState.moveClassifications[moveIndex];
  if (cls && cls.symbol) {
    span.textContent = san + cls.symbol;
    span.style.color = cls.color;
    span.style.fontWeight = 'bold';
  } else {
    span.textContent = san;
    span.style.color = '';
    span.style.fontWeight = '';
  }
}

// Update Chart.js eval graph with current data.
// Arrays are reallocated only when the game length changes; otherwise every
// call mutates the existing arrays in place — no per-redraw allocation churn.
function drawAnalysisEvalGraph() {
  const chart = AppState.evalChart;
  if (!chart) return;

  const evalHistory = AppState.graphEvalHistory;
  const len = evalHistory.length;
  const d = chart.data;

  if (d.labels.length !== len) {
    d.labels = Array.from({ length: len }, (_, i) => i);
    d.datasets[0].data = new Array(len);
    d.datasets[1].data = new Array(len);
    d.datasets[1].pointBackgroundColor = new Array(len);
    d.datasets[1].pointBorderColor = new Array(len);
    d.datasets[1].pointRadius = new Array(len);
  }

  const evalData = d.datasets[0].data;
  const clsData = d.datasets[1].data;
  const clsBg = d.datasets[1].pointBackgroundColor;
  const clsBorder = d.datasets[1].pointBorderColor;
  const clsRadius = d.datasets[1].pointRadius;

  for (let i = 0; i < len; i++) {
    const val = evalHistory[i];
    const evalVal = (val !== undefined) ? Math.max(-11, Math.min(11, val)) : null;
    evalData[i] = evalVal;

    // Classification markers — only show blunders, brilliancies, and great moves
    const cls = AppState.moveClassifications[i];
    clsData[i] = evalVal;
    const showMarker = cls && cls.symbol && (cls.symbol === '??' || cls.symbol === '!!' || cls.symbol === '!');
    clsBg[i] = showMarker ? cls.color : 'transparent';
    clsBorder[i] = showMarker ? '#fff' : 'transparent';
    clsRadius[i] = showMarker ? 4 : 0;
  }

  chart.update('none');
  syncGraphPixelCache();
  drawGraphDot();
}

function rebuildGameFromMoves() {
  if (AppState.inSideline && AppState.currentIndex > AppState.sidelineBranchIndex) {
    // Load mainline position at branch point from cache, then replay sideline moves
    AppState.game.load(AppState.fenCache[AppState.sidelineBranchIndex]);
    const sidelineDepth = AppState.currentIndex - AppState.sidelineBranchIndex;
    for (let j = 0; j < sidelineDepth; j++) {
      AppState.game.move(AppState.sidelineMoves[j]);
    }
  } else if (AppState.fenCache.length > 0 && AppState.currentIndex < AppState.fenCache.length) {
    AppState.game.load(AppState.fenCache[AppState.currentIndex]);
  } else {
    // Fallback for positions off the mainline (user-made moves)
    AppState.game.reset();
    for (let i = 0; i < AppState.currentIndex; i++) {
      AppState.game.move(AppState.userMoves[i]);
    }
  }
  AppState.board.position(AppState.game.fen());
}

// PGN handling
function loadPGN() {
  const el = document.getElementById('pgn-input');
  const pgnText = (el.dataset.pgn || el.value).trim();

  if (!pgnText) {
    showError('Please enter a PGN.');
    return;
  }

  loadPGNFromText(pgnText);
}

function loadPGNFromText(pgnText) {
  // Strip inline comments (e.g. { [%clk 0:01:00] }) that chess.js can't parse
  const cleanedPgn = pgnText.replace(/\{[^}]*\}/g, '').replace(/  +/g, ' ');

  const tempGame = new Chess();
  if (!tempGame.load_pgn(cleanedPgn)) {
    showError('Invalid PGN format.');
    return;
  }

  // Reset and load the game
  AppState.game.load_pgn(cleanedPgn);
  AppState.pgnMainlineMoves = AppState.game.history();
  AppState.userMoves = [...AppState.pgnMainlineMoves];
  AppState.currentIndex = 0;
  AppState.gameLoaded = true;
  AppState.inSideline = false;
  AppState.sidelineBranchIndex = -1;
  AppState.sidelineMoves = [];

  // Build FEN cache for O(1) navigation
  AppState.fenCache = [];
  const fenBuilder = new Chess();
  AppState.fenCache.push(fenBuilder.fen());
  for (let i = 0; i < AppState.pgnMainlineMoves.length; i++) {
    fenBuilder.move(AppState.pgnMainlineMoves[i]);
    AppState.fenCache.push(fenBuilder.fen());
  }

  // Store separate copy for graph
  AppState.graphMainlineMoves = [...AppState.pgnMainlineMoves];
  AppState.graphEvalHistory = new Array(AppState.graphMainlineMoves.length + 1);
  AppState.graphEvalHistory[0] = 0.15; // Lichess Cp(15) starting advantage for white
  AppState.moveClassifications = new Array(AppState.graphMainlineMoves.length + 1);
  AppState.cachedAccuracy = null;
  AppState.cachedAccuracyLength = 0;
  AppState.notationDirty = true;

  // Reset to starting position
  AppState.game.reset();
  AppState.board.start();

  updateGameStatus();

  // Auto-analyze graph positions (uses lite engine for speed/stability)
  AppState.graphDrawn = true;
  analyzeGraphPositions();

  if (AppState.engineEnabled) {
    updateStockfishAnalysis();
  }
  updateDisplay();
  drawAnalysisEvalGraph();
}

// Fetch a game from Lichess by ID or URL and load it
async function fetchLichessGame(gameIdOrUrl) {
  // Extract game ID from various URL formats
  let gameId = gameIdOrUrl.trim();

  // Handle full URLs: https://lichess.org/AbCdEfGh, https://lichess.org/AbCdEfGh/black, etc.
  const urlMatch = gameId.match(/lichess\.org\/([a-zA-Z0-9]{8})/);
  if (urlMatch) {
    gameId = urlMatch[1];
  }

  // Strip any trailing path segments or anchors from a bare ID
  gameId = gameId.replace(/[/#?].*$/, '');

  // Validate: Lichess game IDs are 8 alphanumeric characters
  if (!/^[a-zA-Z0-9]{8}$/.test(gameId)) {
    showError('Invalid Lichess game ID. Expected 8 characters (e.g. AbCdEfGh).');
    return;
  }

  // Show loading state
  const loadingEl = document.getElementById('stockfish-loading');
  if (loadingEl) {
    loadingEl.textContent = 'Fetching game from Lichess...';
    loadingEl.style.display = 'block';
  }

  try {
    const response = await fetch(`https://lichess.org/game/export/${gameId}?clocks=false&evals=false`, {
      headers: { 'Accept': 'application/x-chess-pgn' }
    });

    if (!response.ok) {
      throw new Error(response.status === 404
        ? 'Game not found on Lichess.'
        : `Lichess API error: ${response.status}`);
    }

    const pgn = await response.text();

    // Store full PGN and show preview
    const pgnEl = document.getElementById('pgn-input');
    pgnEl.dataset.pgn = pgn;
    const firstLine = pgn.split('\n').find(l => l.trim() && !l.startsWith('[')) || pgn.substring(0, 60);
    pgnEl.value = firstLine.substring(0, 60);
    document.getElementById('pgn-copy').style.display = '';

    // Load the game
    loadPGNFromText(pgn);


  } catch (error) {
    showError(error.message || 'Failed to fetch game from Lichess.');
  } finally {
    if (loadingEl) {
      loadingEl.style.display = 'none';
    }
  }
}


// ============================================================
// Graph analysis — parallel worker pool, two-pass progressive fill
// ============================================================
// The old path searched positions sequentially at fixed depth 22 (~seconds
// per position; minutes per game). SMP scales sublinearly inside one search,
// but separate positions are embarrassingly parallel — so a pool of small
// workers beats one big-threaded worker. Pass 1 (sketch) fills the whole
// curve with cheap searches in a couple of seconds; pass 2 (polish) redoes
// every point with a bigger node budget, finalises classifications and
// prefetches PVs into evalCache. Cached positions skip the engine entirely.

function analyzeGraphPositions() {
  const positions = [];
  const tempGame = new Chess();

  positions.push({ fen: tempGame.fen(), moveIndex: 0 });
  for (let i = 0; i < AppState.graphMainlineMoves.length; i++) {
    tempGame.move(AppState.graphMainlineMoves[i]);
    // Forced positions (≤1 legal reply) carry the previous eval — no search
    positions.push({ fen: tempGame.fen(), moveIndex: i + 1, forced: tempGame.moves().length <= 1 });
  }

  cancelGraphRun();
  runGraphPasses(positions);
}

// Terminate one worker and forget it everywhere. Safe to call twice.
function discardGraphWorker(worker) {
  try { worker.terminate(); } catch (e) {}
  AppState._graphWorkers.delete(worker);
  const i = AppState.graphPool.indexOf(worker);
  if (i >= 0) AppState.graphPool.splice(i, 1);
}

// Tear the pool down completely, including workers still initialising.
function destroyGraphPool() {
  AppState._graphPoolGen++;
  Array.from(AppState._graphPoolAborts).forEach(abort => abort());
  AppState._graphPoolAborts.clear();
  Array.from(AppState._graphWorkers).forEach(w => { try { w.terminate(); } catch (e) {} });
  AppState._graphWorkers.clear();
  AppState.graphPool = [];
  AppState._graphPoolPromise = null;
  AppState._graphRunActive = false;
}

function cancelGraphRun() {
  AppState._graphRunId++;
  // Hard-reset whenever a run is mid-flight OR a pool init is still pending.
  // The init case matters: _graphRunActive is set before `await ensureGraphPool()`
  // resolves, so the old code's `graphPool.forEach(terminate)` ran against a still
  // EMPTY array and terminated nothing. Loading a second PGN while the first was
  // still spinning up therefore orphaned four full-net workers (~79MB net + 32MB
  // hash each) that stayed alive and unreachable for the life of the tab — the
  // leak behind both the slowdown and the eventual OOM crash.
  // (An idle, fully-built pool is still left warm and reused by the next run.)
  if (AppState._graphRunActive || AppState._graphPoolPromise) {
    destroyGraphPool();
  }
}

function createGraphPoolWorker(timeoutMs) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(ENGINES[GRAPH_POOL_ENGINE].script);
    } catch (err) {
      return reject(err);
    }
    // Tracked from birth, so a cancel during init can still reach it
    AppState._graphWorkers.add(worker);

    let settled = false;
    function settle(ok, payload) {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimeout);
      AppState._graphPoolAborts.delete(abort);
      worker.onmessage = null;
      worker.onerror = null;
      if (ok) {
        resolve(worker);
      } else {
        discardGraphWorker(worker);
        reject(payload);
      }
    }
    // A terminated worker never answers 'isready', so without this a cancelled
    // init would sit pending until its full timeout elapsed.
    const abort = () => settle(false, new Error('Graph pool init cancelled'));
    AppState._graphPoolAborts.add(abort);

    const readyTimeout = setTimeout(
      () => settle(false, new Error('Graph pool worker init timeout')),
      timeoutMs || GRAPH_POOL_INIT_TIMEOUT_MS
    );
    worker.onmessage = function(e) {
      const msg = typeof e.data === 'string' ? e.data : e.data.data;
      if (msg === 'readyok') settle(true);
    };
    worker.onerror = function(err) { settle(false, err); };

    worker.postMessage('uci');
    worker.postMessage('setoption name Threads value ' + (THREADS_SUPPORTED ? GRAPH_POOL_THREADS : 1));
    worker.postMessage('setoption name Hash value ' + GRAPH_POOL_HASH_MB);
    worker.postMessage('isready');
  });
}

// Bring the pool up to GRAPH_POOL_SIZE. Tops up a pool that lost workers to
// crashes (it used to accept ANY non-empty pool, so a run that lost three of
// four workers left every later run in that session single-worker — a silent,
// permanent 4x slowdown). Concurrent callers share one in-flight init.
//
// Workers are started in TWO STAGES, and that is the whole point of this
// function. Booting all four at once gave them ONE shared deadline starting at
// t=0, while the ~75MB net still had to arrive; below ~30-40Mbps the download
// outlasted the 20s timeout and all four failed TOGETHER, so ensureGraphPool
// threw and the graph showed "Graph analysis failed" on an ordinary single PGN
// load. Measured cold-cache: HEAD popped at 30/20/10Mbps, survived 40 with
// only 3.1s of margin.
//
// Staging separates the two costs. Stage 1 is the one worker that actually
// waits for the network, so it gets a budget sized for a slow link; stage 2
// starts from the warmed HTTP cache and returns in ~1.3s, so it keeps a tight
// cap. Measured with the staged boot: 4/4 at every link from 200Mbps down to
// 5Mbps, no popup, and ~1-2s of extra wall clock on fast links (inside
// run-to-run noise).
//
// NOTE: with normal cache headers (which GitHub Pages sends) the browser
// already coalesces the four concurrent fetches — total bytes are ~75MB either
// way, so staging does NOT work by moving less data. It works by giving the
// one unavoidable download a deadline it can meet. Do not "simplify" this back
// into a parallel boot on the theory that the bytes are the same.
async function ensureGraphPool() {
  if (AppState.graphPool.length >= GRAPH_POOL_SIZE) return AppState.graphPool;
  if (AppState._graphPoolPromise) return AppState._graphPoolPromise;

  const gen = AppState._graphPoolGen;

  // Adopt freshly built workers, unless the pool was destroyed while we waited.
  const adopt = born => {
    if (gen !== AppState._graphPoolGen) {
      born.forEach(w => { try { w.terminate(); } catch (e) {} AppState._graphWorkers.delete(w); });
      return false;
    }
    born.forEach(w => { if (!AppState.graphPool.includes(w)) AppState.graphPool.push(w); });
    return true;
  };

  AppState._graphPoolPromise = (async () => {
    // Boot A — one worker alone, warming the HTTP cache for the rest.
    // It gets a long budget because it does the real downloading.
    let bootMs = 0, bootOk = false, recovered = false;
    if (AppState.graphPool.length === 0) {
      const startedAt = Date.now();
      try {
        const first = await createGraphPoolWorker(GRAPH_POOL_FIRST_INIT_TIMEOUT_MS);
        bootMs = Date.now() - startedAt;
        bootOk = true;
        if (!adopt([first])) return [];
      } catch (err) {
        console.warn('First graph pool worker failed to initialise:', err);
        if (gen !== AppState._graphPoolGen) return [];
      }
    }

    // Boot B (recovery) — boot A failed, so do NOT fan out yet. Its failure
    // already showed the bytes aren't arriving fast enough, and parallel
    // attempts split the same pipe: four of them each re-download the whole net
    // and all miss. Measured at 10Mbps with caching off, four contending
    // attempts burned 120s and ~450MB and failed, and a solo attempt then
    // finished in 70s. So retry solo, with the most generous budget we allow.
    if (!bootOk && AppState.graphPool.length === 0) {
      const startedAt = Date.now();
      try {
        const solo = await createGraphPoolWorker(GRAPH_POOL_LAST_RESORT_TIMEOUT_MS);
        bootMs = Date.now() - startedAt;
        bootOk = true;
        recovered = true;
        if (!adopt([solo])) return [];
      } catch (err) {
        console.warn('Solo graph pool worker failed to initialise:', err);
        if (gen !== AppState._graphPoolGen) return [];
      }
    }

    // Fan out for the remaining workers, normally served from cache in ~1.3s.
    //
    // Budget: boot A's duration is the honest signal for how much room these
    // need. A budget is a CEILING, not a wait — a worker that loads in 1.3s is
    // unaffected by a large one — so err generous.
    //
    // Skipped entirely when we only got here via recovery AND that recovery was
    // slow. Boot A had already pulled the net by then, so a solo boot still
    // taking tens of seconds means HTTP caching is not helping at all (a hard
    // reload disables it outright). These workers would each re-download ~79MB
    // and time out anyway; keep the small pool and let a later run top it up.
    // A slow boot A on its own does NOT imply this — with caching healthy, a
    // 31.5s first download is still followed by 1.3s cache hits.
    // (Gated on the pool being non-empty rather than on bootOk, so topping up a
    // pool that lost workers — where no boot runs at all — still fans out.)
    const missing = GRAPH_POOL_SIZE - AppState.graphPool.length;
    const cacheIsHelping = !recovered || bootMs <= GRAPH_POOL_WARM_BOOT_MS;
    if (missing > 0 && AppState.graphPool.length > 0 && cacheIsHelping) {
      const fanOutTimeout = Math.min(
        GRAPH_POOL_FIRST_INIT_TIMEOUT_MS,
        Math.max(GRAPH_POOL_INIT_TIMEOUT_MS, bootMs * 2)
      );
      const results = await Promise.allSettled(
        Array.from({ length: missing }, () => createGraphPoolWorker(fanOutTimeout))
      );
      const born = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (!adopt(born)) return [];
    }

    if (AppState.graphPool.length === 0) {
      throw new Error('All graph pool workers failed to initialise');
    }
    return AppState.graphPool;
  })();

  try {
    return await AppState._graphPoolPromise;
  } finally {
    if (gen === AppState._graphPoolGen) AppState._graphPoolPromise = null;
  }
}

async function runGraphPasses(positions) {
  const runId = AppState._graphRunId;
  AppState._graphRunActive = true;
  try {
    const pool = await ensureGraphPool();
    if (runId !== AppState._graphRunId) return;

    // ONE queue, two kinds of task, no barrier between them. Sketch tasks
    // (tiny budget, STRIDED order 0,4,8,…,1,5,9,… so in-flight searches
    // spread across the whole game and spanGaps draws a coarse full-width
    // curve within ~2s) sit at the front; polish tasks follow in game order
    // at one uniform budget. Workers flow straight from sketching into
    // polishing — no idle barrier.
    // (A reduced budget for decided stretches was tried and REVERTED: it
    // systematically softened blunder badges the deep reference shows —
    // see stockfish-batch-eval-findings. Keep polish uniform.)
    const tasks = [];
    for (let r = 0; r < GRAPH_POOL_SIZE; r++) {
      for (let i = r; i < positions.length; i += GRAPH_POOL_SIZE) {
        tasks.push({ pos: positions[i], kind: 'sketch' });
      }
    }
    positions.forEach(pos => tasks.push({ pos, kind: 'polish' }));
    await runGraphPass(pool, tasks, { depthCap: GRAPH_DEPTH }, runId);
    if (runId !== AppState._graphRunId) return;

    flushGraphRedraw();
    AppState.notationDirty = true;
    updateAnalysisOutput();
  } catch (err) {
    console.error('Graph analysis failed:', err);
    showError('Graph analysis failed. Please refresh the page and try again.');
  } finally {
    if (runId === AppState._graphRunId) AppState._graphRunActive = false;
  }
}

// One pass over the task queue, every pool worker pulling from it
function runGraphPass(pool, tasks, opts, runId) {
  return new Promise(resolve => {
    let next = 0;
    let active = 0;
    let settled = false;

    // Watchdog: several paths can leave the queue with no worker able to make
    // progress (a worker terminated while idle still sits in the pool and never
    // answers its 'go'). Rather than hang the pass forever — the graph silently
    // freezing half-drawn — give up and let the caller paint what it has.
    let stallTimer = null;
    function armStall() {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (settled) return;
        console.warn('Graph pass stalled with', tasks.length - next, 'tasks left; finishing early');
        finish();
      }, GRAPH_STALL_TIMEOUT_MS);
    }
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      resolve();
    }

    function maybeFinish() {
      if (settled) return;
      // No live worker can pull another task, so waiting is pointless.
      const stuck = AppState.graphPool.length === 0;
      if (active === 0 &&
          (next >= tasks.length || runId !== AppState._graphRunId || stuck)) {
        finish();
      }
    }

    function pump(worker) {
      if (runId !== AppState._graphRunId || next >= tasks.length) {
        maybeFinish();
        return;
      }
      const task = tasks[next++];
      armStall(); // progress made — reset the wedge detector
      const pos = task.pos;
      const nodes = task.kind === 'sketch' ? GRAPH_SKETCH_NODES : GRAPH_POLISH_NODES;
      const cacheMinDepth = task.kind === 'sketch' ? 12 : GRAPH_SKIP_DEPTH;

      // Forced move — only one legal reply, so the eval is the previous
      // position's eval; searching it would be pure waste (old-path behaviour)
      if (pos.forced && AppState.graphEvalHistory[pos.moveIndex - 1] !== undefined) {
        commitGraphEval(pos, AppState.graphEvalHistory[pos.moveIndex - 1]);
        pump(worker);
        maybeFinish();
        return;
      }
      active++;

      // Cache short-circuit — a deep-enough eval for this FEN already exists
      const cached = AppState.evalCache.get(pos.fen);
      if (cached && cached.depth >= cacheMinDepth && cached.multipvResults[1]) {
        const e = cached.multipvResults[1];
        commitGraphInfo(pos, { depth: cached.depth, score: e.score, mate: e.mate, pv: e.pv }, opts);
        active--;
        pump(worker);
        maybeFinish();
        return;
      }

      // Tablebase shortcut for ≤7-piece positions
      if (countPieces(pos.fen) <= 7) {
        queryTablebase(pos.fen).then(tb => {
          if (runId !== AppState._graphRunId) { active--; maybeFinish(); return; }
          if (tb) {
            const turn = pos.fen.split(' ')[1];
            commitGraphEval(pos, tablebaseCategoryToEval(tb.category, tb.dtz, turn));
            active--;
            pump(worker);
            maybeFinish();
          } else {
            search(); // API empty — fall back to the engine
          }
        }).catch(() => {
          if (runId === AppState._graphRunId) search();
          else { active--; maybeFinish(); }
        });
        return;
      }

      search();

      function search() {
        let last = null;
        // One decrement per task, whatever happens. The old code left the
        // previous search's onerror armed on an idle worker, so a worker dying
        // between tasks decremented `active` for a task already accounted for —
        // driving the counter negative (active === 0 unreachable → hang) or to
        // zero early (partial graph published as if complete).
        let taskDone = false;
        function endTask(pullNext) {
          if (taskDone) return;
          taskDone = true;
          worker.onmessage = null;
          // While idle this worker owes us nothing, but if it dies we must still
          // drop it from the pool or pump() will hand it a task it can't answer.
          worker.onerror = function(err) {
            console.warn('Idle graph pool worker died:', err);
            discardGraphWorker(worker);
            maybeFinish();
          };
          active--;
          if (pullNext) pump(worker);
          maybeFinish();
        }

        worker.onmessage = function(e) {
          const msg = typeof e.data === 'string' ? e.data : e.data.data;
          if (msg.startsWith('info depth') && msg.includes('score') && msg.includes(' pv ')) {
            const info = parseStockfishInfoForGraph(msg, pos.fen);
            if (info) last = info; // keep the deepest line seen before bestmove
          } else if (msg.startsWith('bestmove')) {
            if (runId === AppState._graphRunId && last) commitGraphInfo(pos, last, opts);
            endTask(true);
          }
        };
        worker.onerror = function(err) {
          console.warn('Graph pool worker died, continuing with remaining workers:', err);
          discardGraphWorker(worker);
          // Dead worker: its pump chain ends here. The survivors keep draining
          // the queue, and maybeFinish() now resolves rather than hanging if
          // this was the last one standing.
          endTask(false);
        };
        worker.postMessage('position fen ' + pos.fen);
        worker.postMessage('go depth ' + opts.depthCap + ' nodes ' + nodes);
      }
    }

    armStall();
    pool.slice().forEach(pump);
    maybeFinish();
  });
}

// Commit a tablebase eval for a position
function commitGraphEval(pos, evalScore) {
  AppState.graphEvalHistory[pos.moveIndex] = evalScore;
  updateMoveClassifications(pos.moveIndex);
  // Polish overwrites sketch evals without changing the defined-eval count,
  // so the count check alone won't refresh accuracy — force a recompute
  AppState.cachedAccuracy = null;
  scheduleGraphRedraw(pos.moveIndex);
}

// Commit a parsed engine info line for a position (+ optional PV prefetch)
function commitGraphInfo(pos, info, opts) {
  let evalScore;
  if (info.mate !== undefined) {
    evalScore = info.mate > 0
      ? Math.min(15, 10 + 5 / Math.abs(info.mate))
      : Math.max(-15, -10 - 5 / Math.abs(info.mate));
  } else {
    evalScore = parseFloat(info.score);
    evalScore = Math.max(-10, Math.min(10, evalScore));
  }
  AppState.graphEvalHistory[pos.moveIndex] = evalScore;
  updateMoveClassifications(pos.moveIndex);
  AppState.cachedAccuracy = null; // see commitGraphEval

  if (info.pv && typeof info.depth === 'number') {
    cacheAnalysisResult(pos.fen, {
      1: {
        depth: info.depth,
        score: info.score,
        scoreDisplay: info.mate !== undefined ? `Mate in ${Math.abs(info.mate)}` : info.score,
        pv: info.pv,
        multipv: 1,
        mate: info.mate
      }
    }, { bestMove: info.pv.split(' ')[0], ponder: null }, info.depth);
  }
  scheduleGraphRedraw(pos.moveIndex);
}

// Throttled UI updates — chart repaint at most every GRAPH_REDRAW_MS, and
// notation classification badges patched per move instead of full rebuilds
let _graphRedrawTimer = null;
const _graphPendingBadges = new Set();

function scheduleGraphRedraw(moveIndex) {
  if (moveIndex !== undefined) {
    _graphPendingBadges.add(moveIndex);
    _graphPendingBadges.add(moveIndex + 1); // next move's classification may shift too
  }
  if (_graphRedrawTimer) return;
  _graphRedrawTimer = setTimeout(flushGraphRedraw, GRAPH_REDRAW_MS);
}

function flushGraphRedraw() {
  if (_graphRedrawTimer) { clearTimeout(_graphRedrawTimer); _graphRedrawTimer = null; }
  drawAnalysisEvalGraph();
  _graphPendingBadges.forEach(patchNotationClassification);
  _graphPendingBadges.clear();
}

function parseStockfishInfoForGraph(message, fen) {
  const turn = fen.split(' ')[1]; // 'w' or 'b' — avoids creating a full Chess instance
  const parts = message.split(' ');
  const info = {
    depth: null,
    score: null,
    mate: undefined,
    pv: null
  };

  for (let i = 0; i < parts.length; i++) {
    switch (parts[i]) {
      case 'depth':
        info.depth = parseInt(parts[++i], 10);
        break;
      case 'cp':
        info.score = (parseInt(parts[++i], 10) / 100).toFixed(2);
        break;
      case 'mate':
        info.mate = parseInt(parts[++i], 10);
        break;
      case 'pv':
        info.pv = parts.slice(++i).join(' ');
        i = parts.length;
        break;
    }
  }

  if (info.depth === null) return null;

  // Adjust score based on side to move
  if (turn === 'b') {
    if (info.mate !== undefined) {
      info.mate = -info.mate;
    } else if (info.score !== null) {
      info.score = (-parseFloat(info.score)).toFixed(2);
    }
  }

  return info;
}

// Board control functions
function resetBoard() {
  // Stop analysis
  if (AppState.stockfish) {
    AppState.stockfish.postMessage('stop');
  }
  AppState.isAnalysisInProgress = false;
  
  // Clear promotion state
  AppState.promotionPending = false;
  AppState.promotionMove = null;
  
  // Clear state including game status
  AppState.multipvResults = {};
  AppState.bestMoveInfo = null;
  AppState.lastFen = '';
  AppState.userMoves = [];
  AppState.pgnMainlineMoves = [];
  AppState.currentIndex = 0;
  AppState.gameLoaded = false;
  AppState.gameStatus = 'ongoing';
  AppState.checkmateWinner = null;
  AppState.isInCheck = false;
  AppState.inSideline = false;
  AppState.sidelineBranchIndex = -1;
  AppState.sidelineMoves = [];

// Clear graph state
  AppState.graphDrawn = false;
  AppState._lastArrowKey = '';
  AppState.graphMainlineMoves = [];
  AppState.graphEvalHistory = [];
  AppState.moveClassifications = [];

  // Clear performance caches
  AppState.fenCache = [];
  AppState.cachedAccuracy = null;
  AppState.cachedAccuracyLength = 0;
  AppState.notationDirty = true;
  AppState._graphPixelCache = null;
  // Keeps an idle pool warm across resets; kills only a mid-run one
  cancelGraphRun();
  
  // Reset board
  AppState.game.reset();
  AppState.board.start();
  
  // Clear UI
  AppState._els.pgnInput.value = '';
  AppState._els.pgnInput.dataset.pgn = '';
  document.getElementById('pgn-copy').style.display = 'none';
  clearCanvas(AppState._els.arrowsCtx, AppState._els.arrowsCanvas);
  
  // Clear eval graph
  drawAnalysisEvalGraph();
  
  // Restart analysis
  setTimeout(() => {
    if (AppState.engineEnabled) {
      updateStockfishAnalysis();
    }
  }, 100);
}

//Promotion Grid
function showPromotionGrid(color) {  
  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'promotion-overlay';
  overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  `;
  
  // Create promotion grid
  const grid = document.createElement('div');
  grid.style.cssText = `
    width: 150px;
    height: 150px;
    background-color: rgba(255, 255, 255, 0.95);
    border: 2px solid #333;
    border-radius: 8px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 2px;
    padding: 5px;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
  `;
  
  // Define pieces in order: Queen, Rook, Bishop, Knight
  // Using your actual image file naming convention
  const pieces = [
    { type: 'q', filename: `${color}Q.png` },
    { type: 'r', filename: `${color}R.png` },
    { type: 'b', filename: `${color}B.png` },
    { type: 'n', filename: `${color}N.png` }
  ];
  // these are in an img folder - need to fix
  
  pieces.forEach(pieceInfo => {
    const pieceDiv = document.createElement('div');
    pieceDiv.style.cssText = `
      background-color: white;
      border: 2px solid #ddd;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s ease;
      position: relative;
    `;
    pieceDiv.dataset.piece = pieceInfo.type;
    
    // Create image element
    const pieceImg = document.createElement('img');
    pieceImg.src = `img/chesspieces/wikipedia/${pieceInfo.filename}`;
    pieceImg.style.cssText = `
      width: 50px;
      height: 50px;
      pointer-events: none;
    `;
    pieceImg.alt = `${color === 'w' ? 'White' : 'Black'} ${pieceInfo.type.toUpperCase()}`;
    
    // Add hover effects
    pieceDiv.addEventListener('mouseenter', function() {
      this.style.backgroundColor = '#e8f4fd';
      this.style.borderColor = '#2196F3';
      this.style.transform = 'scale(1.05)';
    });
    
    pieceDiv.addEventListener('mouseleave', function() {
      this.style.backgroundColor = 'white';
      this.style.borderColor = '#ddd';
      this.style.transform = 'scale(1)';
    });
    
    // Add click handler
    pieceDiv.addEventListener('click', function() {
      handlePromotionChoice(pieceInfo.type);
    });
    
    pieceDiv.appendChild(pieceImg);
    grid.appendChild(pieceDiv);
  });
  
  // Click overlay (outside grid) to cancel
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cancelPromotion();
  });

  // ESC key to cancel
  AppState._promotionEscHandler = (e) => {
    if (e.key === 'Escape') cancelPromotion();
  };
  document.addEventListener('keydown', AppState._promotionEscHandler);

  overlay.appendChild(grid);
  document.getElementById('board-container').appendChild(overlay);
}

function cancelPromotion() {
  AppState.promotionPending = false;
  AppState.promotionMove = null;
  _removePromotionOverlay();
  // Snap piece back to pre-move position
  AppState.board.position(AppState.game.fen());
}

function _removePromotionOverlay() {
  const overlay = document.getElementById('promotion-overlay');
  if (overlay) overlay.remove();
  if (AppState._promotionEscHandler) {
    document.removeEventListener('keydown', AppState._promotionEscHandler);
    AppState._promotionEscHandler = null;
  }
}

function handlePromotionChoice(promotionPiece) {
  if (!AppState.promotionPending || !AppState.promotionMove) return;

  const move = AppState.game.move({
    from: AppState.promotionMove.from,
    to: AppState.promotionMove.to,
    promotion: promotionPiece
  });

  if (move) {
    AppState.board.position(AppState.game.fen());
    _applyUserMove();
  }

  AppState.promotionPending = false;
  AppState.promotionMove = null;
  _removePromotionOverlay();
}

function flipBoard() {
  AppState.board.flip();
  AppState._lastArrowKey = ''; // Force arrow redraw on flip
  updateDisplay();
}

// Event listener setup
function setupEventListeners() {
  // Engine selection dropdown
  document.getElementById('engine-select').addEventListener('change', (e) => {
    switchEngine(e.target.value);
    e.target.blur();
  });

  // Engine toggle
  document.getElementById('engine-toggle').addEventListener('change', (e) => {
    toggleEngine();
    // Remove focus from the toggle switch so arrow keys work immediately
    e.target.blur();
  });
  
  // PGN input — paste auto-loads, Enter as fallback
  const pgnEl = document.getElementById('pgn-input');

  pgnEl.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text').trim();
    if (!text) return;
    pgnEl.dataset.pgn = text;
    const firstLine = text.split('\n').find(l => l.trim() && !l.startsWith('[')) || text.substring(0, 60);
    pgnEl.value = firstLine.substring(0, 60);
    document.getElementById('pgn-copy').style.display = '';
    pgnEl.blur();
    loadPGN();
  });

  pgnEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      loadPGN();
      e.target.blur();
      return;
    }
    // Allow paste (Ctrl/Cmd+V) and select-all, block all other typing
    if (!(e.ctrlKey || e.metaKey)) e.preventDefault();
  });

  document.getElementById('pgn-copy').addEventListener('click', () => {
    const pgn = pgnEl.dataset.pgn || pgnEl.value;
    if (pgn) {
      navigator.clipboard.writeText(pgn);
      const btn = document.getElementById('pgn-copy');
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => {
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      }, 1500);
    }
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyPress);
  
  // Window resize — update scale + redraw canvases
  window.addEventListener('resize', debounce(() => {
    updateViewportScale();
    if (Object.keys(AppState.multipvResults).length > 0) {
      updateBoardArrows();
    }
    drawAnalysisEvalGraph();
  }, 250));
  
  // Click handler for interactive notation moves + return-to-mainline
  document.getElementById('analysis-content').addEventListener('click', (e) => {
    // Return to mainline button
    if (e.target.closest('#return-mainline-btn')) {
      _returnToMainline();
      return;
    }

    const link = e.target.closest('.move-link');
    if (!link) return;

    const moveIndex = parseInt(link.dataset.moveIndex);

    if (link.classList.contains('sideline-move')) {
      AppState.inSideline = true;
    } else if (link.classList.contains('mainline-move')) {
      AppState.inSideline = false;
    }

    navigateToMove(moveIndex);
    link.blur();
  });

}

function handleKeyPress(event) {
  // Don't handle shortcuts if promotion is pending
  if (AppState.promotionPending) return;
  
  // Don't handle shortcuts if typing in textarea
  if (event.target.tagName === 'TEXTAREA') return;
  
  // Ensure we're not in any input field
  if (event.target.tagName === 'INPUT') return;
  
  const keyActions = {
    'ArrowLeft': navigateToPreviousMove,
    'ArrowRight': navigateToNextMove,
    'r': resetBoard,
    'f': flipBoard,
    '0': navigateToStart,
    'a': () => {
      AppState.arrowsEnabled = !AppState.arrowsEnabled;
      updateDisplay();
    },
    't': () => {
    document.getElementById('engine-toggle').checked = !document.getElementById('engine-toggle').checked;
    toggleEngine();
  },
    'Escape': () => {
      if (AppState.sidelineMoves.length > 0) {
        _returnToMainline();
      }
    }
  };
  
  const action = keyActions[event.key] || keyActions[event.key.toLowerCase()];
  if (action) {
    event.preventDefault();
    event.stopPropagation();
    action();
  }
}

// Accuracy — exact port of Lichess's open-source algorithm
// (lila modules/analyse AccuracyPercent.scala), validated to within ±0.5 of
// lichess.org's official numbers across server-analysed reference games.
// chess.com's CAPS2 is proprietary/unpublished, so it cannot be standardised
// against; Lichess is the reproducible reference.

// Win% from White's POV, 0-100; cp clamped to ±1000 (WinPercent.fromCentiPawns)
function winPercentFromCp(cp) {
  const c = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

// Per-move accuracy from mover's-POV win% before/after, incl. the +1
// uncertainty bonus. 100 whenever the position improved for the mover.
function accuracyFromWinPercents(before, after) {
  if (after >= before) return 100;
  const winDiff = before - after;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) - 3.166924740191411;
  return Math.max(0, Math.min(100, raw + 1));
}

function _stdDev(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

// Game accuracy per colour: mean of (volatility-weighted mean, harmonic mean)
// of per-move accuracies. Weights come from win% standard deviation over
// sliding windows of the COMBINED (both colours) win% sequence, first window
// duplicated for the opening moves — exactly as lila does it.
// graphEvalHistory holds White-POV pawns ([0] = 0.15 initial advantage);
// ±10 pawns ≡ lila's ±1000cp clamp, mates are stored at 10-15 so they
// saturate identically. Undefined entries (graph pass still running) simply
// exclude the affected moves, converging to the exact value on completion.
function calculateGameAccuracy() {
  const evalHistory = AppState.graphEvalHistory;
  if (!evalHistory || evalHistory.length < 2) return { white: null, black: null };

  const all = evalHistory.map(v => v === undefined ? null : winPercentFromCp(v * 100));
  const moveCount = all.length - 1;
  const windowSize = Math.max(2, Math.min(8, Math.floor(moveCount / 10)));

  // One weight per move: stdev of its window (first window reused for openings)
  const weights = [];
  for (let i = 0; i < moveCount; i++) {
    const start = Math.max(0, Math.min(i - (windowSize - 2), all.length - windowSize));
    const win = all.slice(start, start + windowSize).filter(v => v !== null);
    weights.push(win.length >= 2 ? Math.max(0.5, Math.min(12, _stdDev(win))) : 0.5);
  }

  const perColor = {
    white: { acc: [], w: [] },
    black: { acc: [], w: [] }
  };
  for (let i = 0; i < moveCount; i++) {
    const prev = all[i];
    const next = all[i + 1];
    if (prev === null || next === null) continue;
    const isWhite = i % 2 === 0;
    // Passing (next, prev) for black is lila's perspective flip
    const acc = isWhite ? accuracyFromWinPercents(prev, next) : accuracyFromWinPercents(next, prev);
    const side = isWhite ? perColor.white : perColor.black;
    side.acc.push(acc);
    side.w.push(weights[i]);
  }

  function colorAccuracy(side) {
    if (side.acc.length === 0) return null;
    const weighted = side.acc.reduce((s, a, i) => s + a * side.w[i], 0) /
                     side.w.reduce((a, b) => a + b, 0);
    const harmonicDenom = side.acc.reduce((s, a) => s + 1 / a, 0);
    const harmonic = isFinite(harmonicDenom) ? side.acc.length / harmonicDenom : 0;
    return Math.round(((weighted + harmonic) / 2) * 10) / 10;
  }

  return { white: colorAccuracy(perColor.white), black: colorAccuracy(perColor.black) };
}

// Classify a move based on centipawn change
function classifyMove(evalBefore, evalAfter, isWhiteMove) {
  // Convert to the moving player's perspective (in centipawns)
  const playerEvalBefore = (isWhiteMove ? evalBefore : -evalBefore) * 100;
  const playerEvalAfter = (isWhiteMove ? evalAfter : -evalAfter) * 100;

  // Calculate centipawn change (positive = improvement, negative = loss)
  const cpChange = playerEvalAfter - playerEvalBefore;

  // Classify based on centipawn loss/gain
  if (cpChange >= MOVE_CLASSIFICATION.BRILLIANT.minGain) {
    return MOVE_CLASSIFICATION.BRILLIANT;
  }
  if (cpChange >= MOVE_CLASSIFICATION.GREAT.minGain) {
    return MOVE_CLASSIFICATION.GREAT;
  }
  if (cpChange >= -MOVE_CLASSIFICATION.GOOD.maxLoss) {
    return MOVE_CLASSIFICATION.GOOD;
  }
  if (cpChange >= -MOVE_CLASSIFICATION.INACCURACY.maxLoss) {
    return MOVE_CLASSIFICATION.INACCURACY;
  }
  if (cpChange >= -MOVE_CLASSIFICATION.MISTAKE.maxLoss) {
    return MOVE_CLASSIFICATION.MISTAKE;
  }
  return MOVE_CLASSIFICATION.BLUNDER;
}

// Update move classification for a single move (incremental — O(1) per call)
function updateMoveClassifications(moveIndex) {
  if (!AppState.graphEvalHistory || AppState.graphEvalHistory.length < 2) return;

  // Ensure array is correctly sized
  if (AppState.moveClassifications.length !== AppState.graphEvalHistory.length) {
    AppState.moveClassifications = new Array(AppState.graphEvalHistory.length);
  }

  // Only classify the single move that just got a new eval
  if (moveIndex >= 1) {
    const evalBefore = AppState.graphEvalHistory[moveIndex - 1];
    const evalAfter = AppState.graphEvalHistory[moveIndex];
    if (evalBefore !== undefined && evalAfter !== undefined) {
      const isWhiteMove = (moveIndex % 2 === 1);
      AppState.moveClassifications[moveIndex] = classifyMove(evalBefore, evalAfter, isWhiteMove);
    }
  }

  // Also reclassify the next move if it exists (its "before" eval just changed)
  const nextIndex = moveIndex + 1;
  if (nextIndex < AppState.graphEvalHistory.length) {
    const evalBefore = AppState.graphEvalHistory[nextIndex - 1];
    const evalAfter = AppState.graphEvalHistory[nextIndex];
    if (evalBefore !== undefined && evalAfter !== undefined) {
      const isWhiteMove = (nextIndex % 2 === 1);
      AppState.moveClassifications[nextIndex] = classifyMove(evalBefore, evalAfter, isWhiteMove);
    }
  }
}

// Tablebase functions
function countPieces(fen) {
  const placement = fen.split(' ')[0];
  let count = 0;
  for (const ch of placement) {
    if (ch !== '/' && (ch < '0' || ch > '9')) count++;
  }
  return count;
}

async function queryTablebase(fen) {
  if (AppState.tablebaseCache.has(fen)) {
    return AppState.tablebaseCache.get(fen);
  }
  try {
    const response = await fetch(`https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(fen)}`);
    if (!response.ok) {
      // Cache the miss too. Four pool workers hammering this endpoint get
      // rate-limited, and without this every 429 was re-requested by both the
      // sketch and the polish task for the same FEN, forever.
      AppState.tablebaseCache.set(fen, null);
      return null;
    }
    const data = await response.json();
    AppState.tablebaseCache.set(fen, data);
    return data;
  } catch (e) {
    AppState.tablebaseCache.set(fen, null);
    return null;
  }
}

function tablebaseCategoryToEval(category, dtz, turn) {
  // Convert tablebase category to eval from White's perspective
  // category is from side-to-move's perspective, turn is 'w' or 'b'
  const sign = turn === 'w' ? 1 : -1;
  switch (category) {
    case 'win':
    case 'maybe-win':
    case 'cursed-win':
      return sign * Math.min(15, 10 + 5 / Math.max(1, Math.abs(dtz || 1)));
    case 'loss':
    case 'maybe-loss':
    case 'blessed-loss':
      return sign * Math.max(-15, -10 - 5 / Math.max(1, Math.abs(dtz || 1)));
    case 'draw':
    default:
      return 0;
  }
}

function handleTablebaseResult(tb, fen) {
  const turn = fen.split(' ')[1];
  const CATEGORY_LABELS = {
    'win': 'Win', 'maybe-win': 'Win', 'cursed-win': 'Cursed Win',
    'loss': 'Loss', 'maybe-loss': 'Loss', 'blessed-loss': 'Blessed Loss',
    'draw': 'Draw'
  };
  const FLIP = {
    'win': 'loss', 'loss': 'win',
    'maybe-win': 'maybe-loss', 'maybe-loss': 'maybe-win',
    'cursed-win': 'blessed-loss', 'blessed-loss': 'cursed-win',
    'draw': 'draw'
  };

  AppState.multipvResults = {};
  AppState.isTablebasePosition = true;

  const moves = (tb.moves || []).slice(0, MULTI_PV_LINES);
  moves.forEach((move, i) => {
    const lineNum = i + 1;
    // move.category is from the OPPONENT's perspective after the move — flip it
    const forMover = FLIP[move.category] || move.category;
    const moveEval = tablebaseCategoryToEval(forMover, move.dtz, turn);
    const label = CATEGORY_LABELS[forMover] || forMover;
    const dtzStr = move.dtz != null ? ` (DTZ ${Math.abs(move.dtz)})` : '';

    AppState.multipvResults[lineNum] = {
      depth: 'TB',
      score: moveEval.toFixed(2),
      scoreDisplay: `TB ${label}${dtzStr}`,
      pv: move.uci,
      multipv: lineNum,
      mate: move.checkmate ? (turn === 'w' ? 1 : -1) : undefined,
      tablebase: true
    };
  });

  if (moves.length > 0) {
    AppState.bestMoveInfo = { bestMove: moves[0].uci, ponder: null, tablebase: true };
  }

  AppState.engineBusy = false;
  AppState.isAnalysisInProgress = false;

  updateDisplay();

  if (AppState.pendingAnalysisFen && AppState.pendingAnalysisId !== null) {
    tryStartAnalysis();
  }
}

// Utility functions
// Viewport scaling — zoom the entire UI to fit the browser window
const NATURAL_WIDTH = 1010;
const NATURAL_HEIGHT = 680; // Approx: 500px board + pgn controls + padding
const ZOOM_STEP = 0.05;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;

// User zoom override — null means auto
let userZoomOverride = null;

function loadZoomPreference() {
  try {
    const stored = localStorage.getItem('chess-zoom');
    if (stored !== null) userZoomOverride = parseFloat(stored);
  } catch (e) {}
}

function saveZoomPreference() {
  try {
    if (userZoomOverride !== null) {
      localStorage.setItem('chess-zoom', userZoomOverride.toString());
    } else {
      localStorage.removeItem('chess-zoom');
    }
  } catch (e) {}
}

function computeAutoScale() {
  const w = window.innerWidth / NATURAL_WIDTH;
  const h = window.innerHeight / NATURAL_HEIGHT;
  return Math.min(1.5, w, h);
}

function updateViewportScale() {
  const wrapper = document.getElementById('scale-wrapper');
  if (!wrapper) return;

  const scale = userZoomOverride !== null ? userZoomOverride : computeAutoScale();
  wrapper.style.setProperty('--ui-scale', scale);

  // Update zoom display if settings panel exists
  const zoomLabel = document.getElementById('zoom-level');
  if (zoomLabel) {
    zoomLabel.textContent = Math.round(scale * 100) + '%';
  }

  // Adjust body height for transformed content
  const naturalHeight = wrapper.scrollHeight;
  document.body.style.height = (naturalHeight * scale) + 'px';
}

function adjustZoom(delta) {
  const current = userZoomOverride !== null ? userZoomOverride : computeAutoScale();
  // Snap to nearest 5% step, then apply delta
  const snapped = Math.round(current / ZOOM_STEP) * ZOOM_STEP;
  userZoomOverride = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, snapped + delta)) * 100) / 100;
  saveZoomPreference();
  updateViewportScale();
}

function resetZoom() {
  userZoomOverride = null;
  saveZoomPreference();
  updateViewportScale();
}

function initSettingsPanel() {
  const btn = document.getElementById('settings-btn');
  const controlSection = document.getElementById('engine-control');
  if (!btn || !controlSection) return;

  // Create panel
  const panel = document.createElement('div');
  panel.id = 'settings-panel';
  panel.innerHTML = `
    <label>Zoom</label>
    <div class="zoom-controls">
      <button id="zoom-out" title="Zoom out">−</button>
      <span id="zoom-level">100%</span>
      <button id="zoom-in" title="Zoom in">+</button>
      <button id="zoom-reset" title="Reset to auto" style="font-size:11px;width:auto;padding:0 6px;">Auto</button>
    </div>
  `;
  controlSection.style.position = 'relative';
  controlSection.appendChild(panel);

  // Toggle panel
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('open');
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== btn) {
      panel.classList.remove('open');
    }
  });

  // Zoom controls
  document.getElementById('zoom-out').addEventListener('click', () => adjustZoom(-ZOOM_STEP));
  document.getElementById('zoom-in').addEventListener('click', () => adjustZoom(ZOOM_STEP));
  document.getElementById('zoom-reset').addEventListener('click', () => resetZoom());
}

function clearCanvas(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

function showError(message) {
  alert(message);
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
  });
} else {
  initializeApp();
}