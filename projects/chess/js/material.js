// Material Display Module
const MaterialDisplay = {
  // Standard piece values
  pieceValues: {
    p: 1,
    n: 3,
    b: 3,
    r: 5,
    q: 9
  },

  // Starting material for a standard game
  startingPieces: {
    p: 8,
    n: 2,
    b: 2,
    r: 2,
    q: 1
  },

  // Calculate material count from FEN
  calculateMaterial(fen) {
    const position = fen.split(' ')[0];
    const white = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
    const black = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };

    for (const char of position) {
      const lower = char.toLowerCase();
      if (lower in white) {
        if (char === lower) {
          // Lowercase = black piece
          black[lower]++;
        } else {
          // Uppercase = white piece
          white[lower]++;
        }
      }
    }

    return { white, black };
  },

  // Get material difference in points (positive = white advantage)
  getMaterialDifference(fen) {
    const material = this.calculateMaterial(fen);
    let whitePts = 0;
    let blackPts = 0;

    for (const piece in this.pieceValues) {
      whitePts += material.white[piece] * this.pieceValues[piece];
      blackPts += material.black[piece] * this.pieceValues[piece];
    }

    return whitePts - blackPts;
  },

  // Get captured pieces for each side
  getCapturedPieces(fen) {
    const material = this.calculateMaterial(fen);

    // Captured pieces = starting pieces - current pieces on board
    // White captured = black's missing pieces
    // Black captured = white's missing pieces
    const whiteCaptured = {};  // Pieces white has captured (black's missing pieces)
    const blackCaptured = {};  // Pieces black has captured (white's missing pieces)

    for (const piece in this.startingPieces) {
      whiteCaptured[piece] = this.startingPieces[piece] - material.black[piece];
      blackCaptured[piece] = this.startingPieces[piece] - material.white[piece];
    }

    // Clamp to 0 (in case of promotions creating extra pieces)
    for (const piece in whiteCaptured) {
      whiteCaptured[piece] = Math.max(0, whiteCaptured[piece]);
      blackCaptured[piece] = Math.max(0, blackCaptured[piece]);
    }

    return { whiteCaptured, blackCaptured };
  },

  // Render the material display
  render() {
    const container = document.getElementById('material-display');
    if (!container) return;

    const fen = AppState.game.fen();
    const diff = this.getMaterialDifference(fen);
    const captured = this.getCapturedPieces(fen);

    // Check if there's any material imbalance to display
    const hasWhiteCaptured = Object.values(captured.whiteCaptured).some(v => v > 0);
    const hasBlackCaptured = Object.values(captured.blackCaptured).some(v => v > 0);

    if (!hasWhiteCaptured && !hasBlackCaptured) {
      container.innerHTML = '';
      return;
    }

    let html = '';

    // Left side - Black's captured pieces (pieces white has taken)
    html += '<div class="material-row black-captured">';
    html += this.renderCapturedPieces(captured.whiteCaptured, 'b');
    if (diff > 0) html += `<span class="material-advantage white-advantage">+${diff}</span>`;
    html += '</div>';

    // Right side - White's captured pieces (pieces black has taken)
    html += '<div class="material-row white-captured">';
    html += this.renderCapturedPieces(captured.blackCaptured, 'w');
    if (diff < 0) html += `<span class="material-advantage black-advantage">+${Math.abs(diff)}</span>`;
    html += '</div>';

    container.innerHTML = html;
  },

  // Render captured pieces as images
  renderCapturedPieces(captured, color) {
    // Order: queen, rook, bishop, knight, pawn (most valuable first)
    const pieceOrder = ['q', 'r', 'b', 'n', 'p'];
    let html = '<div class="captured-pieces">';

    for (const piece of pieceOrder) {
      const count = captured[piece] || 0;
      for (let i = 0; i < count; i++) {
        html += `<img src="img/chesspieces/wikipedia/${color}${piece.toUpperCase()}.png"
                      class="captured-piece"
                      alt="${piece}"
                      title="${this.getPieceName(piece)}">`;
      }
    }

    html += '</div>';
    return html;
  },

  // Get human-readable piece name
  getPieceName(piece) {
    const names = {
      p: 'Pawn',
      n: 'Knight',
      b: 'Bishop',
      r: 'Rook',
      q: 'Queen'
    };
    return names[piece] || piece;
  },

  // Calculate total material for a side
  getTotalMaterial(color, fen) {
    const material = this.calculateMaterial(fen);
    const side = color === 'white' ? material.white : material.black;
    let total = 0;

    for (const piece in this.pieceValues) {
      total += side[piece] * this.pieceValues[piece];
    }

    return total;
  }
};
