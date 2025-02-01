var board = null;
    var game = new Chess(); // Create new chess game instance
    var stockfish = new Worker('js/stockfish-16.1-single.js');

    // Global storage for engine analysis
    let multipvResults = {}; // Will store analysis for MultiPV 1-3
    let bestMoveInfo = null; // Best move information

    // PGN navigation globals
    let pgnMoves = [];
    let currentMoveIndex = 0; // How many moves have been applied

    // --- Chessboard.js callbacks ---
    function onDragStart (source, piece, position, orientation) {
      if (game.game_over()) return false;
      // Only allow pieces from the side whose turn it is.
      if ((game.turn() === 'w' && piece.search(/^b/) !== -1) ||
          (game.turn() === 'b' && piece.search(/^w/) !== -1)) {
        return false;
      }
    }
    function onDrop (source, target) {
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
    function onSnapEnd () {
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
    // Note: We issue a "stop" command then wait briefly before sending the new commands.
    function updateStockfish() {
      multipvResults = {};
      bestMoveInfo = null;
      updateOutput();
      clearArrows();

      // Stop any current analysis.
      stockfish.postMessage("stop");

      // Give Stockfish a short moment to stop before sending new commands.
      setTimeout(function() {
        // Request three principal variations.
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
        bestMoveDiv.textContent = `Best Move: ${bestMoveInfo.bestMove} \n `
          //+ (bestMoveInfo.ponder ? `, Ponder: ${bestMoveInfo.ponder}` : '');
        outputDiv.appendChild(bestMoveDiv);
      }

      // Sorted by MultiPV index (1, 2, 3)
      const sortedKeys = Object.keys(multipvResults).sort((a, b) => a - b);
      sortedKeys.forEach(key => {
        const info = multipvResults[key];
        const lineDiv = document.createElement('div');
        //lineDiv.textContent = `${key}. Depth: ${info.depth}, Score: ${info.scoreDisplay}, Line: ${info.pv} `;
        lineDiv.textContent = `${key}. Score: ${info.scoreDisplay} \nLine: ${info.pv}, \n `;
        outputDiv.appendChild(lineDiv);
      });
      
      updateEvaluationBar();
      updateBoardArrows();
    }

    // --- Evaluation Bar Update ---
    function updateEvaluationBar() {
      // Use the MultiPV line 1 (the best line) for evaluation.
      if (!multipvResults[1]) return;
      
      const entry = multipvResults[1];
      let effectiveEval;
      
      // If a mate score exists, use an extreme value.
      if (entry.mate !== undefined) {
        // Stockfish returns mate from the side to move.
        // Always show white’s advantage, so invert if black’s turn.
        let mateVal = entry.mate;
        if (game.turn() === 'b') {
          mateVal = -mateVal;
        }
        effectiveEval = (mateVal > 0) ? 10 : -10;
      } else {
        // Otherwise, use the centipawn score.
        // entry.score is from the side-to-move perspective.
        effectiveEval = parseFloat(entry.score);
        if (game.turn() === 'b') {
          effectiveEval = -effectiveEval;
        }
        // Clamp the evaluation between -10 and +10.
        effectiveEval = Math.max(-10, Math.min(10, effectiveEval));
      }
      
      // Compute the percentage of the bar that should be white.
      // For effectiveEval: -10 -> 0% white, 0 -> 50% white, +10 -> 100% white.
      const whitePercentage = ((effectiveEval + 10) / 20) * 100;
      
      const evalBar = document.getElementById('eval-bar');
      if (whitePercentage <= 0) {
        evalBar.style.background = "black";
      } else if (whitePercentage >= 100) {
        evalBar.style.background = "white";
      } else {
        // Use a hard–edge gradient: white from 0% up to whitePercentage%, then black.
        evalBar.style.background = `linear-gradient(to top, white ${whitePercentage}%, black ${whitePercentage}%)`;
      }
    }

    // --- Board Arrows Update ---
    function clearArrows() {
      const svg = document.getElementById('arrows-overlay');
      // Remove all child nodes except the <defs> section.
      while (svg.lastChild && svg.lastChild.nodeName !== 'defs') {
        svg.removeChild(svg.lastChild);
      }
    }
    // Compute the center coordinates of a square.
    // Assumes board width 400, each square 50x50, with a8 at the top-left.
    function getSquareCenter(square) {
      const file = square[0];
      const rank = parseInt(square[1], 10);
      const fileIndex = file.charCodeAt(0) - 'a'.charCodeAt(0);
      const x = fileIndex * 50 + 25;
      const y = (8 - rank) * 50 + 25;
      return { x, y };
    }
    function updateBoardArrows() {
      clearArrows();
      const svg = document.getElementById('arrows-overlay');
      // Define colors for each MultiPV line.
      const colors = { 1: 'red', 2: 'blue', 3: 'green' };

      const sortedKeys = Object.keys(multipvResults).sort((a, b) => a - b);
      sortedKeys.forEach(key => {
        const pv = multipvResults[key].pv;
        if (!pv) return;
        const moves = pv.split(' ');
        if (moves.length === 0) return;
        let move = moves[0];
        // Expect move in UCI notation (e.g., "e2e4" or "e7e8q").
        if (move.length < 4) return;
        const from = move.substring(0,2);
        const to = move.substring(2,4);

        const start = getSquareCenter(from);
        const end = getSquareCenter(to);

        // Create an SVG line with an arrow marker.
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", start.x);
        line.setAttribute("y1", start.y);
        line.setAttribute("x2", end.x);
        line.setAttribute("y2", end.y);
        line.setAttribute("stroke", colors[key] || "black");
        line.setAttribute("stroke-width", "4");
        line.setAttribute("marker-end", "url(#arrowhead)");
        svg.appendChild(line);
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
              // Save the numeric score (in pawns)
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
      // Save the move history then reset the board for step‐by‐step navigation.
      pgnMoves = game.history();
      currentMoveIndex = 0;
      game.reset();
      board.start();
      updateStockfish();
    });

    document.getElementById('next-move').addEventListener('click', function() {
      if (currentMoveIndex >= pgnMoves.length) return;
      game.move(pgnMoves[currentMoveIndex]);
      currentMoveIndex++;
      board.position(game.fen());
      updateStockfish();
    });

    document.getElementById('prev-move').addEventListener('click', function() {
      if (currentMoveIndex <= 0) return;
      game.undo();
      currentMoveIndex--;
      board.position(game.fen());
      updateStockfish();
    });

    document.getElementById('reset-board').addEventListener('click', function() {
      game.reset();
      currentMoveIndex = 0;
      pgnMoves = [];
      board.start();
      updateStockfish();
      document.getElementById('pgn-input').value = "";
    });