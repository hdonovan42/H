// Chess Analysis Script - Updated Version with Eval Graph and Engine Control
// Constants
const BOARD_SIZE = 500;
const SQUARE_SIZE = BOARD_SIZE / 8;
const ANALYSIS_DEBOUNCE_TIME = 200;
const ANALYSIS_DEPTH = 15;
const MULTI_PV_LINES = 3;

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
  gameLoaded: false,
  engineEnabled: true, // New state for engine toggle
  gameStatus: 'ongoing', // 'ongoing', 'checkmate', 'draw'
  checkmateWinner: null, // 'white', 'black', or null
  isInCheck: false,
  promotionPending: false,
  promotionMove: null, // Stores the pending promotion move
  promotionCallback: null, // Callback function to execute after promotion choice
  // New properties for interactive graph
  graphClickAreas: [], // Store clickable areas for graph points
  graphHoverIndex: -1  // Currently hovered graph point (-1 = none)
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

AppState.hasLoadedOnce = false;

// Stockfish initialization
function initializeStockfish() {
  try {
    AppState.stockfish = new Worker('js/stockfish-17-lite-single.js');
    
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
  document.getElementById('stockfish-loading').style.display = 'none';
  if (AppState.engineEnabled) {
    updateStockfishAnalysis();
  }
}

function handleAnalysisInfo(message) {
  if (!AppState.stockfishReady || !AppState.engineEnabled) return;
  
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
  if (!AppState.stockfishReady || !AppState.engineEnabled) return;
  
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

// Stockfish analysis update (debounced)
function updateStockfishAnalysis() {
  // If engine is disabled, don't analyze
  if (!AppState.engineEnabled || !AppState.stockfish) {
    return;
  }
  
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
    if (!AppState.engineEnabled || !AppState.stockfish || !AppState.stockfishReady) {
      return;
    }
    
    AppState.isAnalysisInProgress = true;

    // Clear previous arrow results to prevent leftover arrows, but keep eval for eval bar
    const oldEvalResult = AppState.multipvResults[1];
    AppState.multipvResults = {};
    if (oldEvalResult) {
      AppState.multipvResults[1] = oldEvalResult; // Keep eval for eval bar stability
    }
    
    try {
      // Stop current analysis
      AppState.stockfish.postMessage('stop');
      
      // Start new analysis after a brief delay
      setTimeout(() => {
        if (AppState.stockfish && AppState.engineEnabled) {
          AppState.stockfish.postMessage(`position fen ${currentFen}`);
          AppState.stockfish.postMessage(`go depth ${ANALYSIS_DEPTH}`);
          
          // Add a timeout to detect frozen analysis
          setTimeout(() => {
            if (AppState.isAnalysisInProgress && AppState.lastFen === currentFen) {
              console.warn('Analysis appears to be frozen, you may need to toggle the engine');
              // Don't auto-toggle, let the user decide
            }
          }, 15000); // 15 seconds should be enough for depth 15
        }
      }, 50);
    } catch (error) {
      console.error('Error updating Stockfish analysis:', error);
      AppState.isAnalysisInProgress = false;
    }
  }, 100); // Reduced from 300ms to 100ms for faster response
}

// Display update functions
function updateDisplay() {
  updateAnalysisOutput();
  updateEvaluationBar();
  if (AppState.arrowsEnabled && AppState.engineEnabled) {
    updateBoardArrows();
  } else {
    // Clear arrows if disabled
    const canvas = document.getElementById('arrows-overlay');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function updateAnalysisOutput() {
  const outputDiv = document.getElementById('stockfish-output');
  outputDiv.innerHTML = '';

  // Show game status ONLY in analysis panel
  if (AppState.gameStatus !== 'ongoing') {
    const statusDiv = document.createElement('div');
    statusDiv.style.cssText = `
      padding: 12px;
      border-radius: 5px;
      margin-bottom: 10px;
      text-align: center;
      font-weight: bold;
      font-size: 14px;
    `;
    
    let statusText = '';
    let statusStyles = '';
    
    switch (AppState.gameStatus) {
      case 'checkmate':
        if (AppState.checkmateWinner === 'white') {
          statusText = 'WHITE WIN';
          statusStyles = 'color: white; background-color: white; color: black; border: 2px solid #333;';
        } else {
          statusText = 'BLACK WIN';
          statusStyles = 'color: white; background-color: black;';
        }
        break;
      case 'draw':
        statusText = 'DRAW';
        statusStyles = 'color: white; background-color: #6c757d;';
        break;
    }
    
    statusDiv.style.cssText += statusStyles;
    statusDiv.textContent = statusText;
    outputDiv.appendChild(statusDiv);
  }

  // Show engine status if disabled
  if (!AppState.engineEnabled) {
    const statusDiv = document.createElement('div');
    statusDiv.style.color = "#dc3545";
    statusDiv.style.backgroundColor = "#f8d7da";
    statusDiv.style.padding = "10px";
    statusDiv.style.borderRadius = "3px";
    statusDiv.style.marginBottom = "10px";
    statusDiv.textContent = "Engine is disabled. Toggle on to resume analysis.";
    outputDiv.appendChild(statusDiv);
  }

  if (AppState.bestMoveInfo && AppState.engineEnabled) {
    const bestMoveDiv = document.createElement('div');
    bestMoveDiv.textContent = `Best Move: ${AppState.bestMoveInfo.bestMove}\n`;
    outputDiv.appendChild(bestMoveDiv);
  }

  // Sorted by MultiPV index (1, 2, 3) - original format
  if (AppState.engineEnabled) {
    const sortedKeys = Object.keys(AppState.multipvResults).sort((a, b) => a - b);
    sortedKeys.forEach(key => {
      const info = AppState.multipvResults[key];
      const lineDiv = document.createElement('div');
      
      // Highlight mate lines
      if (info.mate !== undefined) {
        lineDiv.style.cssText = `
          background-color: ${info.mate > 0 ? '#d4edda' : '#f8d7da'};
          padding: 5px;
          margin: 2px 0;
          border-radius: 3px;
          font-weight: bold;
        `;
      }
      
      lineDiv.textContent = `${key}. Score: ${info.scoreDisplay}\nLine: ${info.pv}\n`;
      outputDiv.appendChild(lineDiv);
    });
  }

  // Display current game notation - now interactive
  const notationDiv = document.createElement('div');
  notationDiv.style.marginTop = "20px";
  notationDiv.style.fontFamily = "monospace";
  let notationHTML = "<strong>Notation:</strong><br>";

  // Build moves in pairs for proper chess notation
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
    
    if (!isWhiteMainline && AppState.gameLoaded) {
      whiteClasses.push('deviation');
    }
    if (isWhiteCurrent) {
      whiteClasses.push('current');
    }
    
    notationHTML += `<span class="${whiteClasses.join(' ')}" data-move-index="${whiteMoveIndex}">${whiteMove}${!isWhiteMainline && AppState.gameLoaded ? '*' : ''}</span>`;
    
  // Black move (if exists)
  if (blackMove) {
    const blackMoveIndex = i + 2;
    const isBlackMainline = AppState.pgnMainlineMoves.length > (i + 1) && 
                           AppState.pgnMainlineMoves[i + 1] === blackMove;
    const isBlackCurrent = blackMoveIndex === AppState.currentIndex;
    const blackClasses = ['move-link', 'black-move'];
    
    if (!isBlackMainline && AppState.gameLoaded) {
      blackClasses.push('deviation');
    }
    if (isBlackCurrent) {
      blackClasses.push('current');
    }
    
    notationHTML += ` <span class="${blackClasses.join(' ')}" data-move-index="${blackMoveIndex}">${blackMove}${!isBlackMainline && AppState.gameLoaded ? '*' : ''}</span>`;
  }
  
  notationHTML += `</div>`;
}

// Add game result to notation if game is over
if (AppState.gameStatus === 'checkmate') {
  notationHTML += AppState.checkmateWinner === 'white' ? ' <strong>1-0</strong>' : ' <strong>0-1</strong>';
} else if (AppState.gameStatus === 'draw') {
  notationHTML += ' <strong>½-½</strong>';
}

notationDiv.innerHTML = notationHTML;
outputDiv.appendChild(notationDiv);
  
  // Analysis status
  if (AppState.isAnalysisInProgress && AppState.engineEnabled) {
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
    evalText = "M" + Math.abs(entry.mate);
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
  let textColor;
  
  if (AppState.board.orientation() === 'black') {
    // When board is flipped, gradient goes "to bottom" 
    // Bottom of bar shows black when whitePercentage < 100
    textColor = whitePercentage >= 100 ? "black" : "white";
  } else {
    // When board is normal, gradient goes "to top"
    // Bottom of bar shows white when whitePercentage > 0
    textColor = whitePercentage > 0 ? "black" : "white";
  }
  
  overlay.style.color = textColor;
  overlay.textContent = evalText;
}

// Arrow drawing functions
function updateBoardArrows() {
  const canvas = document.getElementById('arrows-overlay');
  const ctx = canvas.getContext('2d');
  
  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Don't draw if no analysis results or engine is disabled
  if (Object.keys(AppState.multipvResults).length === 0 || !AppState.engineEnabled) {
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
  
  // Calculate center line position (0.0 evaluation)
  const centerY = margin.top + chartHeight / 2;
  
  // Shade the area below the center line (black advantage)
  ctx.fillStyle = '#e0e0e0'; // Light grey
  ctx.fillRect(margin.left, centerY, chartWidth, chartHeight / 2);
  
  // Draw center line (0.0 evaluation)
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
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
  if (AppState.evalHistory.length <= 1) {
    // Clear click areas if no data
    AppState.graphClickAreas = [];
    return;
  }
  
  // Clear and rebuild click areas
  AppState.graphClickAreas = [];
  
  // Draw evaluation line and store click areas
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
      
      // Store click area for this point
      AppState.graphClickAreas.push({
        x: x,
        y: y,
        radius: 8, // Click detection radius
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
  
  // Draw hover dot if hovering over a point
  if (AppState.graphHoverIndex >= 0 && AppState.graphHoverIndex < AppState.graphClickAreas.length) {
    const area = AppState.graphClickAreas[AppState.graphHoverIndex];
    
    // Draw glow effect
    ctx.save();
    ctx.shadowColor = '#2196F3';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#2196F3';
    ctx.beginPath();
    ctx.arc(area.x, area.y, 5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }
}

// Toggle engine on/off
function toggleEngine() {
  AppState.engineEnabled = !AppState.engineEnabled;
  
  if (AppState.engineEnabled) {
    // Engine turned on - completely restart Stockfish
    console.log('Restarting Stockfish engine...');
    
    // Terminate the old worker if it exists
    if (AppState.stockfish) {
      try {
        AppState.stockfish.terminate();
      } catch (e) {
        console.error('Error terminating old Stockfish worker:', e);
      }
    }
    
    // Reset all engine-related state
    AppState.stockfish = null;
    AppState.stockfishReady = false;
    AppState.multipvResults = {};
    AppState.bestMoveInfo = null;
    AppState.isAnalysisInProgress = false;
    AppState.lastFen = '';
    
    // Clear any pending analysis
    if (AppState.analysisQueue) {
      clearTimeout(AppState.analysisQueue);
      AppState.analysisQueue = null;
    }
    
    // Show loading indicator
    document.getElementById('stockfish-loading').style.display = 'block';
    
    // Reinitialize Stockfish with a small delay
    setTimeout(() => {
      initializeStockfish();
    }, 100);
    
  } else {
    // Engine turned off - stop analysis
    if (AppState.stockfish) {
      try {
        AppState.stockfish.postMessage('stop');
      } catch (e) {
        console.error('Error stopping Stockfish:', e);
      }
    }
    
    // Clear any pending analysis
    if (AppState.analysisQueue) {
      clearTimeout(AppState.analysisQueue);
      AppState.analysisQueue = null;
    }
    
    AppState.isAnalysisInProgress = false;
    
    // Clear arrows immediately
    const canvas = document.getElementById('arrows-overlay');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  
  updateDisplay();
}

// Navigation functions
function navigateToPreviousMove() {
  if (AppState.currentIndex <= 0) return;
  
  AppState.currentIndex--;
  rebuildGameFromMoves();
  AppState.board.position(AppState.game.fen());
  
  // Update game status for the new position
  updateGameStatus();
  
  // Update display immediately
  updateDisplay();
  
  // Update graph to show current position
  if (AppState.gameLoaded) {
    drawEvalGraph();
  }
  
  // Update Stockfish analysis last
  if (AppState.engineEnabled) {
    updateStockfishAnalysis();
  }
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
  
  // Update game status for the new position
  updateGameStatus();
  
  // Update display immediately
  updateDisplay();
  
  // Update graph to show current position
  if (AppState.gameLoaded) {
    drawEvalGraph();
  }
  
  // Update Stockfish analysis last
  if (AppState.engineEnabled) {
    updateStockfishAnalysis();
  }
}

function navigateToMove(targetIndex) {
  if (targetIndex < 0 || targetIndex > AppState.userMoves.length) return;
  
  AppState.currentIndex = targetIndex;
  rebuildGameFromMoves();
  AppState.board.position(AppState.game.fen());
  
  // Update game status for the new position
  updateGameStatus();
  
  // Update display immediately
  updateDisplay();
  
  // Update graph to show current position
  if (AppState.gameLoaded) {
    drawEvalGraph();
  }
  
  // Update Stockfish analysis last
  if (AppState.engineEnabled) {
    updateStockfishAnalysis();
  }
}

// Graph interaction functions
function handleGraphMouseMove(e) {
  const canvas = document.getElementById('analysis-eval-graph');
  if (!canvas || AppState.graphClickAreas.length === 0) return;
  
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  
  let newHoverIndex = -1;
  
  // Check if mouse is over any click area
  for (let i = 0; i < AppState.graphClickAreas.length; i++) {
    const area = AppState.graphClickAreas[i];
    const dx = x - area.x;
    const dy = y - area.y;
    const distanceSquared = dx * dx + dy * dy;
    
    if (distanceSquared <= area.radius * area.radius) {
      newHoverIndex = i;
      break;
    }
  }
  
  // Only redraw if hover state changed
  if (newHoverIndex !== AppState.graphHoverIndex) {
    AppState.graphHoverIndex = newHoverIndex;
    drawAnalysisEvalGraph();
  }
}

function handleGraphClick(e) {
  if (AppState.graphHoverIndex >= 0 && AppState.graphHoverIndex < AppState.graphClickAreas.length) {
    const area = AppState.graphClickAreas[AppState.graphHoverIndex];
    const targetMoveIndex = area.moveIndex;
    
    // Navigate to the clicked position
    navigateToMove(targetMoveIndex);
  }
}

function handleGraphMouseLeave() {
  if (AppState.graphHoverIndex !== -1) {
    AppState.graphHoverIndex = -1;
    drawAnalysisEvalGraph();
  }
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
  
  // Update game status for starting position
  updateGameStatus();
  
  // Analyze all positions in the game
  analyzeGamePositions();
  
  if (AppState.engineEnabled) {
    updateStockfishAnalysis();
  }
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
  const tempStockfish = new Worker('js/stockfish-17-lite-single.js');
  
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
  AppState.evalHistory = [];
  AppState.gameLoaded = false;
  AppState.gameStatus = 'ongoing';
  AppState.checkmateWinner = null;
  AppState.isInCheck = false;

// Clear graph interaction state
  AppState.graphClickAreas = [];
  AppState.graphHoverIndex = -1;
  
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
  
  overlay.appendChild(grid);
  document.getElementById('board-container').appendChild(overlay);
}

function handlePromotionChoice(promotionPiece) {
  if (!AppState.promotionPending || !AppState.promotionMove) return;
  
  // Execute the promotion move
  const move = AppState.game.move({
    from: AppState.promotionMove.from,
    to: AppState.promotionMove.to,
    promotion: promotionPiece
  });
  
  if (move) {
    // Update move history
    AppState.userMoves = AppState.game.history();
    AppState.currentIndex = AppState.userMoves.length;
    
    // Update board position
    AppState.board.position(AppState.game.fen());
    
    // Check for game ending conditions
    updateGameStatus();
    
    if (AppState.engineEnabled) {
      updateStockfishAnalysis();
    }
    updateDisplay();
  }
  
  // Clean up promotion state
  AppState.promotionPending = false;
  AppState.promotionMove = null;
  
  // Remove promotion grid
  const overlay = document.getElementById('promotion-overlay');
  if (overlay) {
    overlay.remove();
  }
}

function flipBoard() {
  AppState.board.flip();
  updateDisplay();
}

// Event listener setup
function setupEventListeners() {
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
    drawEvalGraph();
  }, 250));
  
  // Prevent arrow key scrolling
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
    }
  });
  
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