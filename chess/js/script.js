// Initialize board, game, and Stockfish engine.
var board = null;
var game = new Chess();
var stockfish = new Worker('js/stockfish-16.1-single.js');

// Global storage for engine analysis
let multipvResults = {}; // Stores analysis for MultiPV 1-3
let bestMoveInfo = null; // Best move information

// PGN navigation globals
let pgnMoves = [];
let currentMoveIndex = 0; // How many moves have been applied

// --- Chessboard.js callbacks ---
function onDragStart(source, piece, position, orientation) {
  if (game.game_over()) return false;
  // Only allow pieces from the side whose turn it is.
  if ((game.turn() === 'w' && piece.search(/^b/) !== -1) ||
      (game.turn() === 'b' && piece.search(/^w/) !== -1)) {
    return false;
  }
}

function onDrop(source, target) {
  var move = game.move({
    from: source,
    to: target,
    promotion: 'q'
  });
  if (move === null) return 'snapback';
  // Clear any loaded PGN navigation when a new move is made.
  pgnMoves = [];
  currentMoveIndex = 0;
  updateStockfish();
}

function onSnapEnd() {
  board.position(game.fen());
}

var config = {
  draggable: true,
  position: 'start',
  dropOffBoard: 'snapback',
  sparePieces: false,
  onDragStart: onDragStart,
  onDrop: onDrop,
  onSnapEnd: onSnapEnd
};
board = Chessboard('myBoard', config);

// --- Stockfish Setup & Update ---
stockfish.postMessage('uci');

// Update Stockfish analysis.
function updateStockfish() {
  multipvResults = {};
  bestMoveInfo = null;
  updateOutput();
  clearArrows(); // Clear arrows on canvas

  // Stop any current analysis.
  stockfish.postMessage("stop");

  // Give Stockfish a short moment to stop before sending new commands.
  setTimeout(function() {
    stockfish.postMessage("setoption name MultiPV value 3");
    stockfish.postMessage(`position fen ${game.fen()}`);
    stockfish.postMessage('go depth 15');
  }, 50);
}

// --- Update Output Display ---
function updateOutput() {
  const outputDiv = document.getElementById('stockfish-output');
  outputDiv.innerHTML = '';

  if (bestMoveInfo) {
    const bestMoveDiv = document.createElement('div');
    bestMoveDiv.textContent = `Best Move: ${bestMoveInfo.bestMove}\n`;
    outputDiv.appendChild(bestMoveDiv);
  }

  // Sorted by MultiPV index (1, 2, 3)
  const sortedKeys = Object.keys(multipvResults).sort((a, b) => a - b);
  sortedKeys.forEach(key => {
    const info = multipvResults[key];
    const lineDiv = document.createElement('div');
    lineDiv.textContent = `${key}. Score: ${info.scoreDisplay}\nLine: ${info.pv}\n`;
    outputDiv.appendChild(lineDiv);
  });

  updateEvaluationBar();
  updateBoardArrows();
}

// --- Evaluation Bar Update ---
function updateEvaluationBar() {
  if (!multipvResults[1]) return;

  const entry = multipvResults[1];
  let effectiveEval;

  if (entry.mate !== undefined) {
    let mateVal = entry.mate;
    if (game.turn() === 'b') {
      mateVal = -mateVal;
    }
    effectiveEval = (mateVal > 0) ? 10 : -10;
  } else {
    effectiveEval = parseFloat(entry.score);
    if (game.turn() === 'b') {
      effectiveEval = -effectiveEval;
    }
    effectiveEval = Math.max(-10, Math.min(10, effectiveEval));
  }

  // Map effectiveEval to whitePercentage.
  const whitePercentage = ((effectiveEval + 10) / 20) * 100;
  const evalBar = document.getElementById('eval-bar');
  if (whitePercentage <= 0) {
    evalBar.style.background = "black";
  } else if (whitePercentage >= 100) {
    evalBar.style.background = "white";
  } else {
    evalBar.style.background = `linear-gradient(to top, white ${whitePercentage}%, black ${whitePercentage}%)`;
  }
}

// --- Arrow Drawing on Canvas (Lichess.org style) ---

// Clear the arrows by clearing the canvas.
function clearArrows() {
  const canvas = document.getElementById('arrows-overlay');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/**
* * Draw an arrow from point "from" to point "to" on the given canvas context.
 * The main line ends exactly at the base midpoint of the arrowhead so that the
 * arrowhead attaches directly with no gap.
 * @param {CanvasRenderingContext2D} ctx - The canvas context.
 * @param {Object} from - The starting point {x, y}.
 * @param {Object} to - The tip of the arrow {x, y}.
 * @param {number} lineWidth - The thickness of the line.
 * @param {number} alpha - The opacity (0 to 1) of the arrow.
 */
function drawArrow(ctx, from, to, lineWidth, alpha) {
  const headLength = 16; // Length of the arrowhead (along the arrow direction)
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const angle = Math.atan2(dy, dx);

  // Compute the midpoint of the arrowhead's base.
  // The arrowhead is an isosceles triangle with its tip at "to" and base angle 30° (π/6).
  // The base of the triangle lies along the line direction. Its midpoint is given by:
  // baseMid = to - (headLength * cos(π/6)) * (cos(angle), sin(angle))
  const cosOffset = Math.cos(Math.PI / 6); // ≈ 0.8660
  const baseMid = {
    x: to.x - headLength * cosOffset * Math.cos(angle),
    y: to.y - headLength * cosOffset * Math.sin(angle)
  };

  // Set the drawing color to blue with the provided opacity.
  const color = `rgba(0, 0, 255, ${alpha})`;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;

  // Draw the main line from "from" to the base midpoint.
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(baseMid.x, baseMid.y);
  ctx.stroke();

  // Compute the two base corners of the arrowhead using ±30° offsets.
  const offsetAngle = Math.PI / 6; // 30 degrees
  const baseLeft = {
    x: to.x - headLength * Math.cos(angle - offsetAngle),
    y: to.y - headLength * Math.sin(angle - offsetAngle)
  };
  const baseRight = {
    x: to.x - headLength * Math.cos(angle + offsetAngle),
    y: to.y - headLength * Math.sin(angle + offsetAngle)
  };

  // Draw the arrowhead as a filled triangle.
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);         // Tip of the arrow
  ctx.lineTo(baseLeft.x, baseLeft.y);
  ctx.lineTo(baseRight.x, baseRight.y);
  ctx.closePath();
  ctx.fill();
}

// Compute the center coordinates of a square on a 400x400 board with each square 50x50.
function getSquareCenter(square) {
  const file = square[0];
  const rank = parseInt(square[1], 10);
  const fileIndex = file.charCodeAt(0) - 'a'.charCodeAt(0);
  const x = fileIndex * 50 + 25;
  const y = (8 - rank) * 50 + 25;
  return { x, y };
}

// Draw arrows for each analysis line using the canvas overlay.
function updateBoardArrows() {
  const canvas = document.getElementById('arrows-overlay');
  const ctx = canvas.getContext('2d');
  clearArrows();

  // Define drawing styles for each MultiPV index.
  // Best move (1): opaque, thicker
  // Second best (2): moderately opaque, medium thickness
  // Third best (3): translucent, thinnest
  const styles = {
    1: { lineWidth: 6, alpha: 1 },
    2: { lineWidth: 4, alpha: 0.7 },
    3: { lineWidth: 2, alpha: 0.4 }
  };

  const sortedKeys = Object.keys(multipvResults).sort((a, b) => a - b);
  sortedKeys.forEach(key => {
    const pv = multipvResults[key].pv;
    if (!pv) return;
    const moves = pv.split(' ');
    if (moves.length === 0) return;
    const move = moves[0];
    if (move.length < 4) return;
    const from = move.substring(0, 2);
    const to = move.substring(2, 4);
    const start = getSquareCenter(from);
    const end = getSquareCenter(to);
    const style = styles[key] || { lineWidth: 4, alpha: 0.7 };
    drawArrow(ctx, start, end, style.lineWidth, style.alpha);
  });
}

// --- Stockfish Message Handling ---
stockfish.onmessage = function(event) {
  const message = (typeof event.data === "string") ? event.data : event.data.data;
  console.log("Message from Stockfish:", message);

  if (message === 'readyok') {
    console.log("Stockfish is ready!");
  } else if (message.startsWith('info depth')) {
    const parts = message.split(' ');
    let depth = null, score = null, pv = null, multipv = 1, mate = undefined;
    for (let i = 0; i < parts.length; i++) {
      switch(parts[i]) {
        case 'depth':
          depth = parseInt(parts[i+1], 10);
          i++;
          break;
        case 'multipv':
          multipv = parseInt(parts[i+1], 10);
          i++;
          break;
        case 'cp':
          score = (parseInt(parts[i+1], 10) / 100).toFixed(2);
          i++;
          break;
        case 'mate':
          mate = parseInt(parts[i+1], 10);
          i++;
          break;
        case 'pv':
          pv = parts.slice(i+1).join(' ');
          i = parts.length;
          break;
      }
    }
    if (depth !== null && pv !== null) {
      let scoreDisplay = (mate !== undefined) ? ("Mate in " + mate) : score;
      multipvResults[multipv] = { depth, score, scoreDisplay, pv };
      if (mate !== undefined) {
        multipvResults[multipv].mate = mate;
      }
      updateOutput();
    }
  } else if (message.startsWith('bestmove')) {
    const parts = message.split(' ');
    bestMoveInfo = { bestMove: parts[1] };
    if (parts.length >= 4 && parts[2] === 'ponder') {
      bestMoveInfo.ponder = parts[3];
    }
    updateOutput();
  }
};

// Tell Stockfish we're ready.
stockfish.postMessage("isready");

// --- PGN Controls & Navigation ---
document.getElementById('load-pgn').addEventListener('click', function() {
  const pgnText = document.getElementById('pgn-input').value;
  if (!pgnText.trim()) {
    alert("Please enter a PGN.");
    return;
  }
  // Load the PGN.
  const loadSuccess = game.load_pgn(pgnText);
  if (!loadSuccess) {
    alert("Invalid PGN.");
    return;
  }
  // Save the move history then reset the board for step-by-step navigation.
  pgnMoves = game.history();
  currentMoveIndex = 0;
  game.reset();
  board.start();
  updateStockfish();
});

// standalone functions for prev move and next move logic as they are called twice

function goToPreviousMove() {
  if (currentMoveIndex <= 0) return;
  game.undo();
  currentMoveIndex--;
  board.position(game.fen());
  updateStockfish();
};

function goToNextMove() {
  if (currentMoveIndex >= pgnMoves.length) return;
  game.move(pgnMoves[currentMoveIndex]);
  currentMoveIndex++;
  board.position(game.fen());
  updateStockfish();
};

// prev move called by button press or left arrow key -
document.getElementById('prev-move').addEventListener('click', function() {
  goToPreviousMove();
});

document.addEventListener('keydown', function(event) {
  if (event.key === 'ArrowLeft') {
    goToPreviousMove();
  }
})

// next move called by button press or right arrow key
document.getElementById('next-move').addEventListener('click', function() {
  goToNextMove()
});

document.addEventListener('keydown', function(event) {
  if (event.key === 'ArrowRight') {
    goToNextMove();
  }
});

document.getElementById('reset-board').addEventListener('click', function() {
  game.reset();
  currentMoveIndex = 0;
  pgnMoves = [];
  board.start();
  updateStockfish();
  document.getElementById('pgn-input').value = "";
});

function flipBoard() {
  board.orientation(board.orientation() === 'white' ? 'black' : 'white');
}

document.getElementById('flip-board').addEventListener('click', flipBoard);

