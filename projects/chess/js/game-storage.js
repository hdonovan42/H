// Game Storage Module
const GameStorage = {
  userGames: [],
  gamesListVisible: false,

  // Save current game to Firestore
  async saveGame() {
    if (!AuthModule.currentUser) {
      showError('Please sign in to save games.');
      return null;
    }

    const pgnText = document.getElementById('pgn-input').value.trim();
    if (!pgnText) {
      showError('No game to save. Please load a PGN first.');
      return null;
    }

    // Check if game has been analyzed
    if (!AppState.graphDrawn) {
      showError('Please analyze the game before saving.');
      return null;
    }

    // Extract game metadata from PGN headers
    const headers = this.extractPGNHeaders(pgnText);

    const gameData = {
      pgn: pgnText,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      whitePlayer: headers.White || 'Unknown',
      blackPlayer: headers.Black || 'Unknown',
      result: headers.Result || '*',
      userColor: this.detectUserColor(headers),
      opening: headers.Opening || headers.ECO || '',
      event: headers.Event || '',
      date: headers.Date || '',
      accuracy: calculateGameAccuracy(),
      moveClassifications: AppState.moveClassifications.map(c => c ? {
        symbol: c.symbol,
        color: c.color
      } : null),
      evalHistory: [...AppState.graphEvalHistory],
      analyzed: true,
      analysisDepth: ANALYSIS_DEPTH,
      totalMoves: AppState.graphMainlineMoves.length
    };

    try {
      // Check storage limits for free tier
      const userDoc = await db.collection('users').doc(AuthModule.currentUser.uid).get();
      const subscription = userDoc.data()?.subscription || { tier: 'free' };
      const currentGames = this.userGames.length;

      if (subscription.tier === 'free' && currentGames >= 50) {
        showError('Storage limit reached. Upgrade to Premium for unlimited game storage.');
        return null;
      }

      const docRef = await db.collection('users')
        .doc(AuthModule.currentUser.uid)
        .collection('games')
        .add(gameData);

      // Update user stats
      await this.updateUserStats(gameData);

      // Add to local cache
      this.userGames.unshift({
        id: docRef.id,
        ...gameData,
        createdAt: new Date()
      });

      this.renderGamesList();
      this.showSaveConfirmation();

      return docRef.id;
    } catch (error) {
      console.error('Error saving game:', error);
      showError('Failed to save game. Please try again.');
      return null;
    }
  },

  // Show save confirmation
  showSaveConfirmation() {
    const btn = document.getElementById('save-game-btn');
    if (btn) {
      const originalText = btn.textContent;
      btn.textContent = 'Saved!';
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 2000);
    }
  },

  // Load user's games from Firestore
  async loadUserGames(userId) {
    try {
      const snapshot = await db.collection('users')
        .doc(userId)
        .collection('games')
        .orderBy('createdAt', 'desc')
        .limit(100)
        .get();

      this.userGames = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate() || new Date()
      }));

      this.renderGamesList();
      console.log(`Loaded ${this.userGames.length} games`);
    } catch (error) {
      console.error('Error loading games:', error);
    }
  },

  // Extract headers from PGN
  extractPGNHeaders(pgn) {
    const headers = {};
    const headerRegex = /\[(\w+)\s+"([^"]+)"\]/g;
    let match;
    while ((match = headerRegex.exec(pgn)) !== null) {
      headers[match[1]] = match[2];
    }
    return headers;
  },

  // Detect which color the user played
  detectUserColor(headers) {
    if (!AuthModule.currentUser) return 'unknown';

    const userEmail = AuthModule.currentUser.email?.toLowerCase() || '';
    const userName = AuthModule.currentUser.displayName?.toLowerCase() || '';

    const white = (headers.White || '').toLowerCase();
    const black = (headers.Black || '').toLowerCase();

    // Check for exact or partial matches
    if (white.includes(userEmail) || white.includes(userName) ||
        userEmail.includes(white) || userName.includes(white)) {
      return 'white';
    }
    if (black.includes(userEmail) || black.includes(userName) ||
        userEmail.includes(black) || userName.includes(black)) {
      return 'black';
    }

    // Check for common patterns
    const knownEngines = ['stockfish', 'komodo', 'leela', 'alphazero', 'computer'];
    if (knownEngines.some(e => white.includes(e))) {
      return 'black';
    }
    if (knownEngines.some(e => black.includes(e))) {
      return 'white';
    }

    return 'unknown';
  },

  // Update user statistics
  async updateUserStats(gameData) {
    const userId = AuthModule.currentUser.uid;
    const userRef = db.collection('users').doc(userId);

    try {
      await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        const currentStats = userDoc.data()?.stats || {
          gamesAnalyzed: 0,
          averageAccuracy: { white: 0, black: 0 },
          commonMistakeTypes: { inaccuracy: 0, mistake: 0, blunder: 0 }
        };

        // Update stats
        const count = currentStats.gamesAnalyzed;
        const newStats = {
          gamesAnalyzed: count + 1,
          averageAccuracy: {
            white: this.runningAverage(currentStats.averageAccuracy.white,
                                       gameData.accuracy?.white,
                                       count),
            black: this.runningAverage(currentStats.averageAccuracy.black,
                                       gameData.accuracy?.black,
                                       count)
          },
          commonMistakeTypes: this.aggregateMistakes(currentStats.commonMistakeTypes,
                                                     gameData.moveClassifications)
        };

        transaction.update(userRef, { stats: newStats });
      });
    } catch (error) {
      console.error('Error updating user stats:', error);
    }
  },

  // Calculate running average
  runningAverage(currentAvg, newValue, count) {
    if (newValue === null || newValue === undefined) return currentAvg;
    return ((currentAvg * count) + newValue) / (count + 1);
  },

  // Aggregate mistake counts
  aggregateMistakes(current, classifications) {
    const counts = { ...current };
    if (classifications) {
      classifications.forEach(c => {
        if (c?.symbol === '?!') counts.inaccuracy++;
        if (c?.symbol === '?') counts.mistake++;
        if (c?.symbol === '??') counts.blunder++;
      });
    }
    return counts;
  },

  // Load a saved game into the analysis board
  loadSavedGame(gameId) {
    const game = this.userGames.find(g => g.id === gameId);
    if (!game) {
      showError('Game not found');
      return;
    }

    // Set PGN input
    document.getElementById('pgn-input').value = game.pgn;

    // Load the game
    loadPGN();

    // Auto-flip board if user played black
    if (game.userColor === 'black') {
      AppState.board.orientation('black');
    }

    // Close games list
    this.toggleGamesList();
  },

  // Delete a saved game
  async deleteGame(gameId) {
    if (!confirm('Are you sure you want to delete this game?')) {
      return;
    }

    try {
      await db.collection('users')
        .doc(AuthModule.currentUser.uid)
        .collection('games')
        .doc(gameId)
        .delete();

      // Remove from local cache
      this.userGames = this.userGames.filter(g => g.id !== gameId);
      this.renderGamesList();
    } catch (error) {
      console.error('Error deleting game:', error);
      showError('Failed to delete game');
    }
  },

  // Toggle games list visibility
  toggleGamesList() {
    this.gamesListVisible = !this.gamesListVisible;
    const panel = document.getElementById('games-list-panel');
    if (panel) {
      panel.style.display = this.gamesListVisible ? 'block' : 'none';
    }
  },

  // Render the games list
  renderGamesList() {
    const container = document.getElementById('games-list-content');
    if (!container) return;

    if (this.userGames.length === 0) {
      container.innerHTML = '<p class="no-games">No saved games yet. Analyze a game and click "Save Game" to store it.</p>';
      return;
    }

    let html = '';
    this.userGames.forEach(game => {
      const date = game.createdAt instanceof Date
        ? game.createdAt.toLocaleDateString()
        : 'Unknown date';

      const accuracyText = game.accuracy?.white !== null
        ? `${game.accuracy.white?.toFixed(1)}% / ${game.accuracy.black?.toFixed(1)}%`
        : 'Not analyzed';

      html += `
        <div class="game-item" onclick="GameStorage.loadSavedGame('${game.id}')">
          <div class="game-players">
            <span class="white-player">${game.whitePlayer}</span>
            <span class="vs">vs</span>
            <span class="black-player">${game.blackPlayer}</span>
          </div>
          <div class="game-meta">
            <span class="game-result">${game.result}</span>
            <span class="game-date">${date}</span>
          </div>
          <div class="game-accuracy">Accuracy: ${accuracyText}</div>
          <button class="delete-game-btn" onclick="event.stopPropagation(); GameStorage.deleteGame('${game.id}')">Delete</button>
        </div>
      `;
    });

    container.innerHTML = html;
  }
};

// Global function for toggling games list
function toggleGamesList() {
  GameStorage.toggleGamesList();
}
