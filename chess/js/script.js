// Chess Analysis Script - Updated Version with Eval Graph
// Constants
const BOARD_SIZE = 500;
const SQUARE_SIZE = BOARD_SIZE / 8;
const ANALYSIS_DEBOUNCE_TIME = 300;
const ANALYSIS_DEPTH = 15;
const MULTI_PV_LINES = 3;

// Chess piece symbols for better readability
const PIECE_SYMBOLS = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟'
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
  analysisQueue: null,
  lastFen: '',
  isAnalysisInProgress: false,
  stockfishReady: false,
  arrowsEnabled: true,
  evalHistory: [], // Store evaluation for each position
  gameLoaded: false
};

// Initialize the application
function initializeApp() {
  // Initialize Chess.js game
  AppState.game = new Chess();
  
  // Initialize Stockfish
  initializeStockfish();
  
  // Initialize board with configuration
  const config = {
    draggable: true,
    position: 'start',
    dropOffBoard: 'snapback',
    sparePieces: false,
    onDragStart: handleDragStart,
    onDrop: handleDrop,
    onSnapEnd: handleSnapEnd
  };
  
  AppState.board = Chessboard('myBoard', config);
  
  // Set up event listeners
  setupEventListeners();
  
  // Initialize empty eval graph
  drawEvalGraph();
}

// Stockfish initialization
function initializeStockfish() {
  try {
    AppState.stockfish = new Worker('js/stockfish-16.1-single.js');
    AppState.stockfish.postMessage('uci');
    AppState.stockfish.postMessage('setoption name MultiPV value ' + MULTI_PV_LINES);
    AppState.stockfish.postMessage('isready');
    
    AppState.stockfish.onmessage = handleStockfishMessage;
  } catch (error) {
    console.error('Failed to initialize Stockfish:', error);
    showError('Failed to load chess engine. Please refresh the page.');
  }
}

// Stockfish message handler
function handleStockfishMessage(event) {
  const message = typeof event.data === 'string' ? event.data : event.data.data;
  
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
  document.getElementById('stockfish-loading').style.display = 'none';
  updateStockfishAnalysis();
}

function handleAnalysisInfo(message) {
  if (!AppState.stockfishReady) return;
  
  const info = parseStockfishInfo(message);
  if (!info) return;
  
  // Check if this is analysis for the current position
  // If not, ignore it (this prevents old analysis from overwriting new position)
  const currentFen = AppState.game.fen();
  if (currentFen !== AppState.lastFen) return;
  
  AppState.multipvResults[info.multipv] = info;
  
  // Update display immediately for better responsiveness
  updateDisplay();
}

function handleBestMove(message) {
  if (!AppState.stockfishReady) return;
  
  // Check if this is analysis for the current position
  const currentFen = AppState.game.fen();
  if (currentFen !== AppState.lastFen) return;
  
  AppState.isAnalysisInProgress = false;
  
  const parts = message.split(' ');
  AppState.bestMoveInfo = { 
    bestMove: parts[1],
    ponder: parts[3] || null
  };
  
  updateDisplay();
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
  const move = AppState.game.move({
    from: source,
    to: target,
    promotion: 'q' // TODO: Add promotion dialog
  });
  
  if (move === null) return 'snapback';
  
  // Update move history
  AppState.userMoves = AppState.game.history();
  AppState.currentIndex = AppState.userMoves.length;
  
  updateStockfishAnalysis();
  updateDisplay();
  
  return 'drop';
}

function handleSnapEnd() {
  AppState.board.position(AppState.game.fen());
}

// Stockfish analysis update (debounced)
function updateStockfishAnalysis() {
  // Cancel pending analysis
  if (AppState.analysisQueue) {
    clearTimeout(AppState.analysisQueue);
    AppState.analysisQueue = null;
  }
  
  const currentFen = AppState.game.fen();
  
  // Skip if already analyzing this position
  if (currentFen === AppState.lastFen && AppState.isAnalysisInProgress) {
    return;
  }
  
  AppState.lastFen = currentFen;
  
  // Debounce analysis request - but keep it short for responsive arrows
  AppState.analysisQueue = setTimeout(() => {
    AppState.isAnalysisInProgress = true;
    
    // Don't clear previous results - keep them until we get new ones
    // This prevents the eval bar from twitching
    
    // Stop current analysis
    AppState.stockfish.postMessage('stop');
    
    // Start new analysis after a brief delay
    setTimeout(() => {
      AppState.stockfish.postMessage(`position fen ${currentFen}`);
      AppState.stockfish.postMessage(`go depth ${ANALYSIS_DEPTH}`);
    }, 50);
  }, 100); // Reduced from 300ms to 100ms for faster response
}

// Display update functions
function updateDisplay() {
  updateAnalysisOutput();
  updateEvaluationBar();
  if (AppState.arrowsEnabled) {
    updateBoardArrows();
  }
}

function updateAnalysisOutput() {
  const outputDiv = document.getElementById('stockfish-output');
  outputDiv.innerHTML = '';

  if (AppState.bestMoveInfo) {
    const bestMoveDiv = document.createElement('div');
    bestMoveDiv.textContent = `Best Move: ${AppState.bestMoveInfo.bestMove}\n`;
    outputDiv.appendChild(bestMoveDiv);
  }

  // Sorted by MultiPV index (1, 2, 3) - original format
  const sortedKeys = Object.keys(AppState.multipvResults).sort((a, b) => a - b);
  sortedKeys.forEach(key => {
    const info = AppState.multipvResults[key];
    const lineDiv = document.createElement('div');
    lineDiv.textContent = `${key}. Score: ${info.scoreDisplay}\nLine: ${info.pv}\n`;
    outputDiv.appendChild(lineDiv);
  });

  // Display current game notation - original format
  const notationDiv = document.createElement('div');
  notationDiv.style.marginTop = "20px";
  notationDiv.style.fontFamily = "monospace";
  let notationHTML = "<strong>Notation:</strong><br>";
  
  for (let i = 0; i < AppState.userMoves.length; i++) {
    // Compare to PGN mainline, if available.
    if (AppState.pgnMainlineMoves.length > i) {
      if (AppState.pgnMainlineMoves[i] === AppState.userMoves[i]) {
        notationHTML += `${i + 1}. ${AppState.userMoves[i]} `;
      } else {
        notationHTML += `<span style="color:red;">${i + 1}. ${AppState.userMoves[i]}*</span> `;
      }
    } else {
      // Moves beyond the loaded PGN.
      notationHTML += `<span style="color:red;">${i + 1}. ${AppState.userMoves[i]}*</span> `;
    }
  }
  
  notationDiv.innerHTML = notationHTML;
  outputDiv.appendChild(notationDiv);
  
  // Analysis status
  if (AppState.isAnalysisInProgress) {
    const statusDiv = document.createElement('div');
    statusDiv.style.marginTop = "10px";
    statusDiv.style.color = "#856404";
    statusDiv.style.backgroundColor = "#fff3cd";
    statusDiv.style.padding = "5px";
    statusDiv.style.borderRadius = "3px";
    statusDiv.textContent = "Analysis in progress...";
    outputDiv.appendChild(statusDiv);
  }
}

function updateEvaluationBar() {
  if (!AppState.multipvResults[1]) return;

  const entry = AppState.multipvResults[1];
  let effectiveEval;

  // The score is already stored from White's perspective in parseStockfishInfo
  if (entry.mate !== undefined) {
    effectiveEval = (entry.mate > 0) ? 10 : -10;
  } else {
    effectiveEval = parseFloat(entry.score);
    effectiveEval = Math.max(-10, Math.min(10, effectiveEval));
  }

  // Compute the percentage of the bar that should be white.
  const whitePercentage = ((effectiveEval + 10) / 20) * 100;

  const evalBar = document.getElementById('eval-bar');

  // If board is flipped, reverse the gradient direction.
  if (AppState.board.orientation() === 'black') {
    if (whitePercentage <= 0) {
      evalBar.style.background = "black";
    } else if (whitePercentage >= 100) {
      evalBar.style.background = "white";
    } else {
      evalBar.style.background = `linear-gradient(to bottom, white ${whitePercentage}%, black ${whitePercentage}%)`;
    }
  } else {
    if (whitePercentage <= 0) {
      evalBar.style.background = "black";
    } else if (whitePercentage >= 100) {
      evalBar.style.background = "white";
    } else {
      evalBar.style.background = `linear-gradient(to top, white ${whitePercentage}%, black ${whitePercentage}%)`;
    }
  }

  // --- Overlay the eval score at the bottom of the eval bar ---
  let evalText = "";
  if (entry.mate !== undefined) {
    evalText = "M" + entry.mate;
  } else {
    evalText = entry.score;
  }
  
  // Try to get an existing overlay element; if none exists, create one.
  let overlay = document.getElementById('eval-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = "eval-overlay";
    overlay.style.position = "absolute";
    overlay.style.bottom = "0";
    overlay.style.width = "100%";
    overlay.style.textAlign = "center";
    overlay.style.pointerEvents = "none";
    overlay.style.fontFamily = "monospace";
    overlay.style.fontSize = "10px";
    evalBar.appendChild(overlay);
  }
  // set text colour to opposite of orientation, for readability
  if (AppState.board.orientation() === 'white') {
    overlay.style.color = "black";
  } else {
    overlay.style.color = "white";
  }
  overlay.textContent = evalText;
}

// Arrow drawing functions
function updateBoardArrows() {
  const canvas = document.getElementById('arrows-overlay');
  const ctx = canvas.getContext('2d');
  
  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Don't draw if no analysis results
  if (Object.keys(AppState.multipvResults).length === 0) {
    return;
  }
  
  // Define drawing styles for each MultiPV index - original blue colors
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
    drawArrow(ctx, from, to, style.lineWidth, style.alpha);
  });
}

function drawArrow(ctx, from, to, lineWidth, alpha) {
  const startPos = getSquareCenter(from);
  const endPos = getSquareCenter(to);
  
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

function getSquareCenter(square) {
  const file = square.charCodeAt(0) - 'a'.charCodeAt(0);
  const rank = parseInt(square[1], 10) - 1;
  const isFlipped = AppState.board.orientation() === 'black';
  
  const x = (isFlipped ? 7 - file : file) * SQUARE_SIZE + SQUARE_SIZE / 2;
  const y = (isFlipped ? rank : 7 - rank) * SQUARE_SIZE + SQUARE_SIZE / 2;
  
  return { x, y };
}

// Evaluation graph drawing
function drawEvalGraph() {
  // Draw in the analysis container
  drawAnalysisEvalGraph();
}

function drawAnalysisEvalGraph() {
  const canvas = document.getElementById('analysis-eval-graph');
  if (!canvas) return; // Safety check
  
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  
  // Clear canvas
  ctx.clearRect(0, 0, width, height);
  
  // Set up margins for compact display (reduced margins since no labels)
  const margin = { top: 10, right: 15, bottom: 10, left: 15 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  
  // Draw background
  ctx.fillStyle = '#f8f8f8';
  ctx.fillRect(0, 0, width, height);
  
  // Draw center line (0.0 evaluation)
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  const centerY = margin.top + chartHeight / 2;
  ctx.moveTo(margin.left, centerY);
  ctx.lineTo(margin.left + chartWidth, centerY);
  ctx.stroke();
  ctx.setLineDash([]);
  
  // Draw axes
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Y-axis
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + chartHeight);
  // X-axis
  ctx.moveTo(margin.left, margin.top + chartHeight);
  ctx.lineTo(margin.left + chartWidth, margin.top + chartHeight);
  ctx.stroke();
  
  // Only draw if we have evaluation data
  if (AppState.evalHistory.length <= 1) return;
  
  // Draw evaluation line
  ctx.strokeStyle = '#2196F3';
  ctx.lineWidth = 2;
  ctx.beginPath();
  
  let hasStarted = false;
  const evalRange = 10; // -10 to +10
  
  for (let i = 0; i < AppState.evalHistory.length; i++) {
    if (AppState.evalHistory[i] !== undefined) {
      const x = margin.left + (i / Math.max(1, AppState.evalHistory.length - 1)) * chartWidth;
      const eval_val = Math.max(-evalRange, Math.min(evalRange, AppState.evalHistory[i]));
      const y = margin.top + chartHeight - ((eval_val + evalRange) / (2 * evalRange)) * chartHeight;
      
      if (!hasStarted) {
        ctx.moveTo(x, y);
        hasStarted = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
  }
  ctx.stroke();
  
  // Draw current position indicator
  if (AppState.currentIndex < AppState.evalHistory.length && 
      AppState.evalHistory[AppState.currentIndex] !== undefined) {
    const x = margin.left + (AppState.currentIndex / Math.max(1, AppState.evalHistory.length - 1)) * chartWidth;
    const eval_val = Math.max(-evalRange, Math.min(evalRange, AppState.evalHistory[AppState.currentIndex]));
    const y = margin.top + chartHeight - ((eval_val + evalRange) / (2 * evalRange)) * chartHeight;
    
    ctx.fillStyle = '#FF5722';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, 2 * Math.PI);
    ctx.fill();
  }
}

// Navigation functions
function navigateToPreviousMove() {
  if (AppState.currentIndex <= 0) return;
  
  AppState.currentIndex--;
  rebuildGameFromMoves();
  AppState.board.position(AppState.game.fen());
  
  // Update display immediately
  updateDisplay();
  
  // Update graph to show current position
  if (AppState.gameLoaded) {
    drawEvalGraph();
  }
  
  // Update Stockfish analysis last
  updateStockfishAnalysis();
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
  rebuildGameFromMoves();
  AppState.board.position(AppState.game.fen());
  
  // Update display immediately
  updateDisplay();
  
  // Update graph to show current position
  if (AppState.gameLoaded) {
    drawEvalGraph();
  }
  
  // Update Stockfish analysis last
  updateStockfishAnalysis();
}

function rebuildGameFromMoves() {
  AppState.game.reset();
  
  for (let i = 0; i < AppState.currentIndex; i++) {
    AppState.game.move(AppState.userMoves[i]);
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
  
  const tempGame = new Chess();
  if (!tempGame.load_pgn(pgnText)) {
    showError('Invalid PGN format.');
    return;
  }
  
  // Reset and load the game
  AppState.game.load_pgn(pgnText);
  AppState.pgnMainlineMoves = AppState.game.history();
  AppState.userMoves = [...AppState.pgnMainlineMoves];
  AppState.currentIndex = 0;
  AppState.gameLoaded = true;
  
  // Initialize eval history array
  AppState.evalHistory = new Array(AppState.pgnMainlineMoves.length + 1);
  
  // Reset to starting position
  AppState.game.reset();
  AppState.board.start();
  
  // Analyze all positions in the game
  analyzeGamePositions();
  
  updateStockfishAnalysis();
  updateDisplay();
  drawEvalGraph();
}

// Analyze all positions in the loaded game
function analyzeGamePositions() {
  const tempGame = new Chess();
  let moveIndex = 0;
  
  // Analyze starting position
  analyzePosition(tempGame.fen(), moveIndex);
  
  // Analyze each position after a move
  for (const move of AppState.pgnMainlineMoves) {
    tempGame.move(move);
    moveIndex++;
    analyzePosition(tempGame.fen(), moveIndex);
  }
}

function analyzePosition(fen, moveIndex) {
  // Create a temporary worker for this analysis
  const tempStockfish = new Worker('js/stockfish-16.1-single.js');
  
  tempStockfish.onmessage = function(event) {
    const message = typeof event.data === 'string' ? event.data : event.data.data;
    
    if (message === 'readyok') {
      tempStockfish.postMessage(`position fen ${fen}`);
      tempStockfish.postMessage('go depth 10');
    } else if (message.startsWith('bestmove')) {
      tempStockfish.terminate();
    } else if (message.startsWith('info depth 10') && message.includes('score')) {
      const info = parseStockfishInfoForGraph(message, fen);
      if (info) {
        let evalScore;
        if (info.mate !== undefined) {
          evalScore = info.mate > 0 ? 10 : -10;
        } else {
          evalScore = parseFloat(info.score);
          evalScore = Math.max(-10, Math.min(10, evalScore));
        }
        
        AppState.evalHistory[moveIndex] = evalScore;
        drawEvalGraph();
      }
    }
  };
  
  tempStockfish.postMessage('uci');
  tempStockfish.postMessage('isready');
}

function parseStockfishInfoForGraph(message, fen) {
  const tempGame = new Chess(fen);
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
  if (tempGame.turn() === 'b') {
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
  if (AppState.analysisQueue) {
    clearTimeout(AppState.analysisQueue);
    AppState.analysisQueue = null;
  }
  
  AppState.stockfish.postMessage('stop');
  AppState.isAnalysisInProgress = false;
  
  // Clear state
  AppState.multipvResults = {};
  AppState.bestMoveInfo = null;
  AppState.lastFen = '';
  AppState.userMoves = [];
  AppState.pgnMainlineMoves = [];
  AppState.currentIndex = 0;
  AppState.evalHistory = [];
  AppState.gameLoaded = false;
  
  // Reset board
  AppState.game.reset();
  AppState.board.start();
  
  // Clear UI
  document.getElementById('pgn-input').value = '';
  clearCanvas(
    document.getElementById('arrows-overlay').getContext('2d'),
    document.getElementById('arrows-overlay')
  );
  
  // Clear eval graph
  drawEvalGraph();
  
  // Restart analysis
  setTimeout(() => updateStockfishAnalysis(), 100);
}

function flipBoard() {
  AppState.board.flip();
  updateDisplay();
}

// Event listener setup
function setupEventListeners() {
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
    drawEvalGraph();
  }, 250));
  
  // Prevent arrow key scrolling
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
    }
  });
}

function handleKeyPress(event) {
  // Don't handle shortcuts if typing in textarea
  if (event.target.tagName === 'TEXTAREA') return;
  
  // Ensure we're not in any input field
  if (event.target.tagName === 'INPUT') return;
  
  const keyActions = {
    'ArrowLeft': navigateToPreviousMove,
    'ArrowRight': navigateToNextMove,
    'r': resetBoard,
    'R': resetBoard,
    'f': flipBoard,
    'F': flipBoard,
    'a': () => {
      AppState.arrowsEnabled = !AppState.arrowsEnabled;
      updateDisplay();
    },
    'A': () => {
      AppState.arrowsEnabled = !AppState.arrowsEnabled;
      updateDisplay();
    }
  };
  
  const action = keyActions[event.key];
  if (action) {
    event.preventDefault();
    event.stopPropagation();
    action();
  }
}

// Utility functions
function clearCanvas(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
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