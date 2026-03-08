// Chess Analysis Script - Updated Version with Eval Graph and Engine Control
// Constants
const BOARD_SIZE = 500;
const SQUARE_SIZE = BOARD_SIZE / 8;
const ANALYSIS_DEBOUNCE_TIME = 200;
const ANALYSIS_DEPTH = 18;
const MULTI_PV_LINES = 3;
const GRAPH_DEPTH = 18;

// Accuracy calculation constants
// Formula based on Lichess/Chess.com approach using win probability
const ACCURACY_COEFFICIENTS = {
  a: 103.1668,
  b: -0.04354,
  c: -3.1669
};

// Move classification thresholds (in centipawns)
const MOVE_CLASSIFICATION = {
  BRILLIANT: { symbol: '!!', color: '#1baca6', minGain: 150 }, // Gains 1.5+ pawns unexpectedly
  GREAT: { symbol: '!', color: '#5c8bb0', maxLoss: 0, minGain: 50 }, // Gains 0.5+ pawns
  GOOD: { symbol: '', color: '#96bc4b', maxLoss: 10 }, // Loses less than 0.1 pawn
  INACCURACY: { symbol: '?!', color: '#f7c631', maxLoss: 50 }, // Loses 0.1-0.5 pawns
  MISTAKE: { symbol: '?', color: '#e6912c', maxLoss: 150 }, // Loses 0.5-1.5 pawns
  BLUNDER: { symbol: '??', color: '#ca3431', maxLoss: Infinity } // Loses 1.5+ pawns
};

// Engine configurations
const ENGINES = {
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
  // New properties for interactive graph
  graphClickAreas: [], // Store clickable areas for graph points
  graphHoverIndex: -1,  // Currently hovered graph point (-1 = none)
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
  cachedAccuracy: null,          // Cached { white, black } accuracy
  cachedAccuracyLength: 0,       // Eval count when accuracy was last computed
  _accuracySums: { whiteTotal: 0, whiteCount: 0, blackTotal: 0, blackCount: 0 },
  notationDirty: true,           // Whether notation needs re-render
  graphWorker: null,             // Persistent worker for graph analysis
  hasLoadedOnce: false,          // Skip init timeout on first load
  _lastArrowKey: '',             // Arrow fingerprint for skip-redraw optimisation
  _graphRAFPending: false        // Throttle flag for graph hover RAF
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
    evalGraphCtx: evalGraph.getContext('2d'),
    stockfishLoading: document.getElementById('stockfish-loading'),
    pgnInput: document.getElementById('pgn-input'),
  };

  // Set up event listeners
  setupEventListeners();

  // Initialize empty eval graph
  drawAnalysisEvalGraph();

  // Fetch Lichess game if ID provided (?game=AbCdEfGh&color=black)
  if (gameParam) {
    fetchLichessGame(gameParam);
  }
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
    AppState.stockfish.postMessage('setoption name Hash value 128');
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
    const pgnText = document.getElementById('pgn-input').value.trim();
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
  
  // Update display immediately for better responsiveness
  updateDisplay();
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
    updateDisplay();
  }
  
  // CRITICAL: Check if there's a pending analysis waiting
  // This handles rapid navigation - start the queued analysis now
  if (AppState.pendingAnalysisFen && AppState.pendingAnalysisId !== null) {
    setTimeout(() => tryStartAnalysis(), 10);
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
  
  // Update move history
  AppState.userMoves = AppState.game.history();
  AppState.currentIndex = AppState.userMoves.length;
  
  // Check for game ending conditions
  updateGameStatus();
  
  if (AppState.engineEnabled) {
    updateStockfishAnalysis();
  }
  updateDisplay();
  
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
  if (!AppState.stockfish || !AppState.stockfishReady || !AppState.engineEnabled) {
    return;
  }
  
  if (!AppState.pendingAnalysisFen || AppState.pendingAnalysisId === null) {
    return;
  }
  
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
  const fen = AppState.pendingAnalysisFen;
  const analysisId = AppState.pendingAnalysisId;
  
  // Clear pending state
  AppState.pendingAnalysisFen = null;
  AppState.pendingAnalysisId = null;
  
  // Mark as active
  AppState.activeAnalysisId = analysisId;
  AppState.engineBusy = true;
  AppState.isAnalysisInProgress = true;
  AppState.lastFen = fen;
  
  // Keep old eval for UI stability
  const oldEval = AppState.multipvResults[1];
  AppState.multipvResults = {};
  if (oldEval) {
    AppState.multipvResults[1] = oldEval;
  }
  AppState.bestMoveInfo = null;
  
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
function updateDisplay() {
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

    const bestMoveText = AppState.bestMoveInfo ? AppState.bestMoveInfo.bestMove : '...';
    bestMoveEl.textContent = `Best Move: ${bestMoveText}`;

    for (let lineNum = 1; lineNum <= MULTI_PV_LINES; lineNum++) {
      const lineDiv = container.querySelector(`#engine-line-${lineNum}`);
      const info = AppState.multipvResults[lineNum];

      if (info) {
        if (info.mate !== undefined) {
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

  let notationHTML = '<div style="margin-top: 20px; font-family: monospace;"><strong>Notation:</strong><br>';

  for (let i = 0; i < AppState.userMoves.length; i += 2) {
    const moveNumber = Math.floor(i / 2) + 1;
    const whiteMove = AppState.userMoves[i];
    const blackMove = AppState.userMoves[i + 1];

    notationHTML += `<div class="move-pair">`;
    notationHTML += `<span class="move-number">${moveNumber}.</span> `;

    // White move
    const whiteMoveIndex = i + 1;
    const isWhiteMainline = AppState.pgnMainlineMoves.length > i &&
                          AppState.pgnMainlineMoves[i] === whiteMove;
    const isWhiteCurrent = whiteMoveIndex === AppState.currentIndex;
    const whiteClasses = ['move-link', 'white-move'];

    if (!isWhiteMainline && AppState.gameLoaded) whiteClasses.push('deviation');
    if (isWhiteCurrent) whiteClasses.push('current');

    const whiteClassification = AppState.moveClassifications[whiteMoveIndex];
    let whiteMoveText = whiteMove;
    let whiteStyle = '';
    if (whiteClassification && whiteClassification.symbol) {
      whiteMoveText += whiteClassification.symbol;
      whiteStyle = `color: ${whiteClassification.color}; font-weight: bold;`;
    }

    notationHTML += `<span class="${whiteClasses.join(' ')}" data-move-index="${whiteMoveIndex}" style="${whiteStyle}">${whiteMoveText}${!isWhiteMainline && AppState.gameLoaded ? '*' : ''}</span>`;

    // Black move
    if (blackMove) {
      const blackMoveIndex = i + 2;
      const isBlackMainline = AppState.pgnMainlineMoves.length > (i + 1) &&
                             AppState.pgnMainlineMoves[i + 1] === blackMove;
      const isBlackCurrent = blackMoveIndex === AppState.currentIndex;
      const blackClasses = ['move-link', 'black-move'];

      if (!isBlackMainline && AppState.gameLoaded) blackClasses.push('deviation');
      if (isBlackCurrent) blackClasses.push('current');

      const blackClassification = AppState.moveClassifications[blackMoveIndex];
      let blackMoveText = blackMove;
      let blackStyle = '';
      if (blackClassification && blackClassification.symbol) {
        blackMoveText += blackClassification.symbol;
        blackStyle = `color: ${blackClassification.color}; font-weight: bold;`;
      }

      notationHTML += ` <span class="${blackClasses.join(' ')}" data-move-index="${blackMoveIndex}" style="${blackStyle}">${blackMoveText}${!isBlackMainline && AppState.gameLoaded ? '*' : ''}</span>`;
    }

    notationHTML += `</div>`;
  }

  // Game result
  if (AppState.gameStatus === 'checkmate') {
    notationHTML += AppState.checkmateWinner === 'white' ? ' <strong>1-0</strong>' : ' <strong>0-1</strong>';
  } else if (AppState.gameStatus === 'draw') {
    notationHTML += ' <strong>½-½</strong>';
  }

  notationHTML += '</div>';
  container.innerHTML = notationHTML;
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

  // Eval score overlay
  const evalText = entry.mate !== undefined ? 'M' + Math.abs(entry.mate) : entry.score;

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
  if (AppState.preloadedFullEngine) return; // Already preloading/preloaded

  try {
    const worker = new Worker(ENGINES.full.script);

    worker.onmessage = function(e) {
      if (e.data === 'uciok') {
        console.log('Full Stockfish engine preloaded and ready');
        worker.postMessage('isready');
      } else if (e.data === 'readyok') {
        // Engine is fully initialized and ready
        AppState.preloadedFullEngine = worker;
      }
    };

    worker.onerror = function(error) {
      console.error('Error preloading full engine:', error);
    };

    worker.postMessage('uci');
  } catch (error) {
    console.error('Failed to preload full engine:', error);
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
    AppState.stockfish.postMessage('setoption name Hash value 128');
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
  if (AppState.gameLoaded) drawAnalysisEvalGraph();
  if (AppState.engineEnabled) updateStockfishAnalysis();
}

function navigateToPreviousMove() {
  if (AppState.currentIndex <= 0) return;
  AppState.currentIndex--;
  _applyNavigation();
}

function navigateToNextMove() {
  if (AppState.pgnMainlineMoves.length > 0 &&
      AppState.currentIndex < AppState.pgnMainlineMoves.length) {
    // Follow mainline
    const mainlineMove = AppState.pgnMainlineMoves[AppState.currentIndex];
    if (AppState.userMoves[AppState.currentIndex] !== mainlineMove) {
      AppState.userMoves[AppState.currentIndex] = mainlineMove;
      AppState.userMoves = AppState.userMoves.slice(0, AppState.currentIndex + 1);
    }
  } else if (AppState.currentIndex >= AppState.userMoves.length) {
    return;
  }
  AppState.currentIndex++;
  _applyNavigation();
}

function navigateToMove(targetIndex) {
  if (targetIndex < 0 || targetIndex > AppState.userMoves.length) return;
  AppState.currentIndex = targetIndex;
  _applyNavigation();
}

function navigateToStart() {
  if (AppState.currentIndex === 0) return;
  AppState.currentIndex = 0;
  _applyNavigation();
}

// Graph interaction functions
function handleGraphMouseMove(e) {
  const canvas = AppState._els ? AppState._els.evalGraph : document.getElementById('analysis-eval-graph');
  if (!canvas || AppState.graphClickAreas.length === 0) return;
  
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  
  // Find the closest move based on X coordinate only (same logic as click)
  let newHoverIndex = -1;
  let minDistance = Infinity;
  
  for (let i = 0; i < AppState.graphClickAreas.length; i++) {
    const area = AppState.graphClickAreas[i];
    const distance = Math.abs(mouseX - area.x);
    
    if (distance < minDistance) {
      minDistance = distance;
      newHoverIndex = i;
    }
  }
  
  // Only redraw if hover state changed, throttled to animation frame
  if (newHoverIndex !== AppState.graphHoverIndex) {
    AppState.graphHoverIndex = newHoverIndex;
    if (!AppState._graphRAFPending) {
      AppState._graphRAFPending = true;
      requestAnimationFrame(() => {
        AppState._graphRAFPending = false;
        drawAnalysisEvalGraph();
      });
    }
  }
}

function handleGraphClick(e) {
  const canvas = AppState._els ? AppState._els.evalGraph : document.getElementById('analysis-eval-graph');
  if (!canvas || AppState.graphClickAreas.length === 0) return;
  
  const rect = canvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  
  // Find the closest move based on X coordinate only
  let closestMoveIndex = -1;
  let minDistance = Infinity;
  
  for (let i = 0; i < AppState.graphClickAreas.length; i++) {
    const area = AppState.graphClickAreas[i];
    const distance = Math.abs(clickX - area.x);
    
    if (distance < minDistance) {
      minDistance = distance;
      closestMoveIndex = area.moveIndex;
    }
  }
  
  // Navigate to the closest move if found — restore full mainline so all moves remain accessible
  if (closestMoveIndex >= 0 && closestMoveIndex <= AppState.graphMainlineMoves.length) {
    AppState.userMoves = [...AppState.graphMainlineMoves];
    navigateToMove(closestMoveIndex);
  }
}

// MINIMAL CHANGE: Graph drawing uses graph data
function drawAnalysisEvalGraph() {
  const canvas = AppState._els ? AppState._els.evalGraph : document.getElementById('analysis-eval-graph');
  if (!canvas) return;

  const ctx = AppState._els ? AppState._els.evalGraphCtx : canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  
  ctx.clearRect(0, 0, width, height);
  
  const margin = { top: 10, right: 15, bottom: 10, left: 15 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  
  ctx.fillStyle = '#f8f8f8';
  ctx.fillRect(0, 0, width, height);
  
  const centerY = margin.top + chartHeight / 2;
  
  ctx.fillStyle = '#e0e0e0';
  ctx.fillRect(margin.left, centerY, chartWidth, chartHeight / 2);
  
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(margin.left, centerY);
  ctx.lineTo(margin.left + chartWidth, centerY);
  ctx.stroke();
  ctx.setLineDash([]);
  
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + chartHeight);
  ctx.moveTo(margin.left, margin.top + chartHeight);
  ctx.lineTo(margin.left + chartWidth, margin.top + chartHeight);
  ctx.stroke();
  
  // Use graphEvalHistory for graph display
  if (AppState.graphEvalHistory.length <= 1) {
    AppState.graphClickAreas = [];
    return;
  }
  
  AppState.graphClickAreas = [];
  
  ctx.strokeStyle = '#2196F3';
  ctx.lineWidth = 2;
  ctx.beginPath();
  
  let hasStarted = false;
  const evalRange = 10;
  
  for (let i = 0; i < AppState.graphEvalHistory.length; i++) {
    if (AppState.graphEvalHistory[i] !== undefined) {
      const x = margin.left + (i / Math.max(1, AppState.graphEvalHistory.length - 1)) * chartWidth;
      const eval_val = Math.max(-evalRange, Math.min(evalRange, AppState.graphEvalHistory[i]));
      const y = margin.top + chartHeight - ((eval_val + evalRange) / (2 * evalRange)) * chartHeight;
      
      AppState.graphClickAreas.push({
        x: x,
        y: y,
        radius: 8,
        moveIndex: i
      });
      
      if (!hasStarted) {
        ctx.moveTo(x, y);
        hasStarted = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
  }
  ctx.stroke();
  
  // Show current position indicator - works with existing logic
  if (AppState.currentIndex < AppState.graphEvalHistory.length && 
      AppState.graphEvalHistory[AppState.currentIndex] !== undefined) {
    const x = margin.left + (AppState.currentIndex / Math.max(1, AppState.graphEvalHistory.length - 1)) * chartWidth;
    const eval_val = Math.max(-evalRange, Math.min(evalRange, AppState.graphEvalHistory[AppState.currentIndex]));
    const y = margin.top + chartHeight - ((eval_val + evalRange) / (2 * evalRange)) * chartHeight;
    
    ctx.fillStyle = '#FF5722';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, 2 * Math.PI);
    ctx.fill();
  }
  
  // Hover effect (unchanged)
  if (AppState.graphHoverIndex >= 0 && AppState.graphHoverIndex < AppState.graphClickAreas.length) {
    const area = AppState.graphClickAreas[AppState.graphHoverIndex];

    ctx.save();
    ctx.shadowColor = '#2196F3';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#2196F3';
    ctx.beginPath();
    ctx.arc(area.x, area.y, 5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }

  // Draw accuracy scores on graph (cached — only recompute when new evals arrive)
  if (AppState.gameLoaded && AppState.graphEvalHistory.some(e => e !== undefined)) {
    const definedEvals = AppState.graphEvalHistory.filter(e => e !== undefined).length;
    if (!AppState.cachedAccuracy || definedEvals !== AppState.cachedAccuracyLength) {
      AppState.cachedAccuracy = calculateGameAccuracy();
      AppState.cachedAccuracyLength = definedEvals;
    }
    const accuracy = AppState.cachedAccuracy;

    ctx.font = 'bold 12px Arial';
    ctx.fillStyle = '#000';

    // White accuracy - top left
    if (accuracy.white !== null) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${accuracy.white}%`, margin.left + 5, margin.top + 3);
    }

    // Black accuracy - bottom left
    if (accuracy.black !== null) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${accuracy.black}%`, margin.left + 5, height - margin.bottom - 3);
    }
  }
}

function handleGraphMouseLeave() {
  if (AppState.graphHoverIndex !== -1) {
    AppState.graphHoverIndex = -1;
    drawAnalysisEvalGraph();
  }
}

function rebuildGameFromMoves() {
  if (AppState.fenCache.length > 0 && AppState.currentIndex < AppState.fenCache.length) {
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
  const pgnText = document.getElementById('pgn-input').value.trim();

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
  AppState.graphEvalHistory[0] = 0.0; // Starting position is equal
  AppState.moveClassifications = new Array(AppState.graphMainlineMoves.length + 1);
  AppState._accuracySums = { whiteTotal: 0, whiteCount: 0, blackTotal: 0, blackCount: 0 };
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

    // Put PGN in textarea for reference
    document.getElementById('pgn-input').value = pgn;

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


function analyzeGraphPositions() {
  const positions = [];
  const tempGame = new Chess();

  positions.push({ fen: tempGame.fen(), moveIndex: 0 });
  for (let i = 0; i < AppState.graphMainlineMoves.length; i++) {
    tempGame.move(AppState.graphMainlineMoves[i]);
    positions.push({ fen: tempGame.fen(), moveIndex: i + 1 });
  }

  // Terminate any existing graph worker and its timeout
  if (AppState._graphWorkerTimeout) {
    clearTimeout(AppState._graphWorkerTimeout);
    AppState._graphWorkerTimeout = null;
  }
  if (AppState.graphWorker) {
    try { AppState.graphWorker.terminate(); } catch (e) {}
    AppState.graphWorker = null;
  }

  // Create a single persistent worker — reuse for all positions
  const worker = new Worker(ENGINES.lite.script);
  AppState.graphWorker = worker;
  let idx = 0;
  let pendingRedraw = false;

  // Safety timeout for entire analysis
  const totalTimeout = setTimeout(() => {
    if (AppState.graphWorker === worker) {
      try { worker.terminate(); } catch (e) {}
      AppState.graphWorker = null;
    }
    AppState._graphWorkerTimeout = null;
  }, positions.length * 8000);
  AppState._graphWorkerTimeout = totalTimeout;

  // Batch UI updates — coalesce redraws into a single rAF
  function scheduleRedraw() {
    if (pendingRedraw) return;
    pendingRedraw = true;
    requestAnimationFrame(() => {
      pendingRedraw = false;
      drawAnalysisEvalGraph();
      AppState.notationDirty = true;
      updateAnalysisOutput();
    });
  }

  function sendNext() {
    if (idx >= positions.length) {
      clearTimeout(totalTimeout);
      AppState._graphWorkerTimeout = null;
      try { worker.terminate(); } catch (e) {}
      if (AppState.graphWorker === worker) AppState.graphWorker = null;
      // Final redraw to ensure everything is rendered
      drawAnalysisEvalGraph();
      AppState.notationDirty = true;
      updateAnalysisOutput();
      return;
    }
    // No ucinewgame per position — preserves hash table for transposition hits
    worker.postMessage(`position fen ${positions[idx].fen}`);
    worker.postMessage(`go depth ${GRAPH_DEPTH}`);
  }

  worker.onmessage = function(event) {
    const message = typeof event.data === 'string' ? event.data : event.data.data;

    if (message === 'readyok') {
      sendNext();
    } else if (message.startsWith('bestmove')) {
      idx++;
      setTimeout(sendNext, 5);
    } else if (message.startsWith(`info depth ${GRAPH_DEPTH}`) && message.includes('score')) {
      const pos = positions[idx];
      const info = parseStockfishInfoForGraph(message, pos.fen);
      if (info) {
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
        updateIncrementalAccuracy(pos.moveIndex);
        scheduleRedraw();
      }
    }
  };

  worker.onerror = function() {
    clearTimeout(totalTimeout);
    AppState._graphWorkerTimeout = null;
    try { worker.terminate(); } catch (e) {}
    if (AppState.graphWorker === worker) AppState.graphWorker = null;
  };

  // Delay start to let main engine initialise first
  setTimeout(() => {
    worker.postMessage('uci');
    worker.postMessage('setoption name Hash value 64');
    worker.postMessage('ucinewgame');
    worker.postMessage('isready');
  }, 500);
}

function parseStockfishInfoForGraph(message, fen) {
  const turn = fen.split(' ')[1]; // 'w' or 'b' — avoids creating a full Chess instance
  const parts = message.split(' ');
  const info = {
    depth: null,
    score: null,
    mate: undefined
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

// Clear graph interaction state
  AppState.graphClickAreas = [];
  AppState.graphHoverIndex = -1;
  AppState.graphDrawn = false;
  AppState._lastArrowKey = '';
  AppState.graphMainlineMoves = [];
  AppState.graphEvalHistory = [];
  AppState.moveClassifications = [];

  // Clear performance caches
  AppState.fenCache = [];
  AppState.cachedAccuracy = null;
  AppState.cachedAccuracyLength = 0;
  AppState._accuracySums = { whiteTotal: 0, whiteCount: 0, blackTotal: 0, blackCount: 0 };
  AppState.notationDirty = true;
  if (AppState.graphWorker) {
    try { AppState.graphWorker.terminate(); } catch (e) {}
    AppState.graphWorker = null;
  }
  
  // Reset board
  AppState.game.reset();
  AppState.board.start();
  
  // Clear UI
  AppState._els.pgnInput.value = '';
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
    AppState.userMoves = AppState.game.history();
    AppState.currentIndex = AppState.userMoves.length;
    AppState.board.position(AppState.game.fen());
    updateGameStatus();
    if (AppState.engineEnabled) updateStockfishAnalysis();
    updateDisplay();
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
  
  // PGN input enter key
  document.getElementById('pgn-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      loadPGN();
      // Remove focus from textarea after loading PGN
      e.target.blur();
    }
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyPress);
  
  // Window resize
  window.addEventListener('resize', debounce(() => {
    if (Object.keys(AppState.multipvResults).length > 0) {
      updateBoardArrows();
    }
    drawAnalysisEvalGraph();
  }, 250));
  
  // Click handler for interactive notation moves
  document.getElementById('analysis-content').addEventListener('click', (e) => {
    if (e.target.classList.contains('move-link')) {
      const moveIndex = parseInt(e.target.dataset.moveIndex);
      navigateToMove(moveIndex);
      e.target.blur();
    }
  });

  // Interactive evaluation graph event listeners
  const evalGraphCanvas = document.getElementById('analysis-eval-graph');
  if (evalGraphCanvas) {
    evalGraphCanvas.addEventListener('mousemove', handleGraphMouseMove);
    evalGraphCanvas.addEventListener('click', handleGraphClick);
    evalGraphCanvas.addEventListener('mouseleave', handleGraphMouseLeave);
  }
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
  }
  };
  
  const action = keyActions[event.key] || keyActions[event.key.toLowerCase()];
  if (action) {
    event.preventDefault();
    event.stopPropagation();
    action();
  }
}

// Accuracy calculation functions

// Convert eval (in pawns) to win probability (0-1)
// Uses the Lichess formula: 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)
function evalToWinProbability(evalScore) {
  const cp = evalScore * 100; // convert pawns to centipawns
  return (50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)) / 100;
}

// Convert centipawn loss to accuracy (0-100)
function cpLossToAccuracy(cpLoss) {
  // Formula: a * exp(b * cpLoss) + c, clamped to 0-100
  const { a, b, c } = ACCURACY_COEFFICIENTS;
  const accuracy = a * Math.exp(b * cpLoss) + c;
  return Math.max(0, Math.min(100, accuracy));
}

// Calculate accuracy for a single move based on win probability change
function calculateMoveAccuracy(evalBefore, evalAfter, isWhiteMove) {
  // Convert to the moving player's perspective
  const playerEvalBefore = isWhiteMove ? evalBefore : -evalBefore;
  const playerEvalAfter = isWhiteMove ? evalAfter : -evalAfter;

  // Calculate win probability before and after
  const winProbBefore = evalToWinProbability(playerEvalBefore);
  const winProbAfter = evalToWinProbability(playerEvalAfter);

  // Win probability loss as percentage points (0-100 scale)
  const wpLoss = Math.max(0, winProbBefore - winProbAfter) * 100;

  // Formula coefficients are designed for win% loss, not centipawn loss
  return cpLossToAccuracy(wpLoss);
}

// Calculate game accuracy for both players
// Incrementally update accuracy running sums for a single move
function updateIncrementalAccuracy(moveIndex) {
  if (moveIndex < 1) return;
  const evalBefore = AppState.graphEvalHistory[moveIndex - 1];
  const evalAfter = AppState.graphEvalHistory[moveIndex];
  if (evalBefore === undefined || evalAfter === undefined) return;

  const isWhiteMove = (moveIndex % 2 === 1);
  const accuracy = calculateMoveAccuracy(evalBefore, evalAfter, isWhiteMove);
  const sums = AppState._accuracySums;

  if (isWhiteMove) {
    sums.whiteTotal += accuracy;
    sums.whiteCount++;
  } else {
    sums.blackTotal += accuracy;
    sums.blackCount++;
  }

  // Invalidate cache so graph picks up new values
  AppState.cachedAccuracy = null;
}

// Calculate game accuracy from running sums (O(1))
function calculateGameAccuracy() {
  const sums = AppState._accuracySums;
  const avgWhite = sums.whiteCount > 0 ? sums.whiteTotal / sums.whiteCount : null;
  const avgBlack = sums.blackCount > 0 ? sums.blackTotal / sums.blackCount : null;

  return {
    white: avgWhite !== null ? Math.round(avgWhite * 10) / 10 : null,
    black: avgBlack !== null ? Math.round(avgBlack * 10) / 10 : null
  };
}

// Get accuracy rating text based on score
function getAccuracyRating(accuracy) {
  if (accuracy >= 95) return { text: 'Brilliant', color: '#1baca6' };
  if (accuracy >= 85) return { text: 'Excellent', color: '#5c8bb0' };
  if (accuracy >= 70) return { text: 'Good', color: '#96bc4b' };
  if (accuracy >= 50) return { text: 'Inaccurate', color: '#e6912c' };
  if (accuracy >= 30) return { text: 'Poor', color: '#ca3431' };
  return { text: 'Very Poor', color: '#8b0000' };
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

// Utility functions
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