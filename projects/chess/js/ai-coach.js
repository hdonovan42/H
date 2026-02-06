// AI Chess Coach Module - Claude API Integration
const AICoach = {
  // TODO: Replace with your actual Cloudflare Worker URL
  WORKER_URL: 'https://chess-coach.YOUR_SUBDOMAIN.workers.dev',

  // Coach panel state
  isPanelOpen: false,
  isAnalyzing: false,
  currentResponse: null,

  // System prompt for chess coaching
  getSystemPrompt() {
    return `You are an expert chess coach with deep knowledge of openings, middlegame strategy, tactics, and endgames. You're analyzing a player's games to provide personalized coaching advice.

Your role is to:
1. Identify patterns in their play (both strengths and weaknesses)
2. Analyze their opening repertoire and suggest improvements
3. Point out recurring mistakes and explain why they're problematic
4. Provide specific, actionable advice they can implement immediately
5. Be encouraging while being honest about areas for improvement

When analyzing games:
- Look for tactical patterns they miss (forks, pins, skewers, discovered attacks)
- Identify positional mistakes (weak squares, bad piece placement, pawn structure issues)
- Note time management patterns if visible
- Recognize opening preparation gaps
- Spot endgame technique issues

Format your responses clearly with sections for:
- **Overall Assessment** (2-3 sentences)
- **Strengths** (what they do well)
- **Areas for Improvement** (prioritized list)
- **Specific Recommendations** (actionable advice)
- **Suggested Study Topics** (resources or themes to focus on)

Use chess notation when referencing specific moves. Keep responses thorough but concise.`;
  },

  // Analyze user's game database
  async analyzeGameDatabase() {
    if (!AuthModule.currentUser) {
      showError('Please sign in to use the AI Coach.');
      return null;
    }

    // Check usage limits for free tier
    const canUse = await this.checkUsageLimits();
    if (!canUse) {
      this.showUpgradePrompt();
      return null;
    }

    // Get user's recent games
    const games = GameStorage.userGames.slice(0, 20);
    if (games.length === 0) {
      showError('No games found. Please save some analyzed games first.');
      return null;
    }

    this.isAnalyzing = true;
    this.updateCoachUI();

    // Build analysis context
    const context = this.buildAnalysisContext(games);

    // Call Claude API
    const response = await this.callCoachAPI(context);

    this.isAnalyzing = false;
    this.currentResponse = response;
    this.updateCoachUI();

    return response;
  },

  // Ask a specific question about user's play
  async askQuestion(question) {
    if (!AuthModule.currentUser) {
      showError('Please sign in to use the AI Coach.');
      return null;
    }

    if (!question || question.trim().length === 0) {
      showError('Please enter a question.');
      return null;
    }

    // Check usage limits
    const canUse = await this.checkUsageLimits();
    if (!canUse) {
      this.showUpgradePrompt();
      return null;
    }

    const games = GameStorage.userGames.slice(0, 10);
    const context = games.length > 0
      ? this.buildAnalysisContext(games)
      : 'No saved games available.';

    this.isAnalyzing = true;
    this.updateCoachUI();

    const response = await this.callCoachAPI(context, question);

    this.isAnalyzing = false;
    this.currentResponse = response;
    this.updateCoachUI();

    return response;
  },

  // Build context from games for Claude
  buildAnalysisContext(games) {
    const stats = this.aggregateStats(games);

    let context = `=== PLAYER STATISTICS (${games.length} games analyzed) ===\n\n`;

    // Overall stats
    context += `Average Accuracy:\n`;
    context += `  - As White: ${stats.avgAccuracy.white.toFixed(1)}%\n`;
    context += `  - As Black: ${stats.avgAccuracy.black.toFixed(1)}%\n\n`;

    context += `Mistake Summary:\n`;
    context += `  - Inaccuracies (?!): ${stats.mistakes.inaccuracy}\n`;
    context += `  - Mistakes (?): ${stats.mistakes.mistake}\n`;
    context += `  - Blunders (??): ${stats.mistakes.blunder}\n\n`;

    context += `Results:\n`;
    context += `  - Wins: ${stats.results.wins}\n`;
    context += `  - Draws: ${stats.results.draws}\n`;
    context += `  - Losses: ${stats.results.losses}\n`;
    context += `  - Win Rate: ${stats.results.wins + stats.results.draws + stats.results.losses > 0
      ? ((stats.results.wins / (stats.results.wins + stats.results.draws + stats.results.losses)) * 100).toFixed(1)
      : 0}%\n\n`;

    // Opening repertoire
    if (Object.keys(stats.openings).length > 0) {
      context += `Opening Repertoire:\n`;
      const sortedOpenings = Object.entries(stats.openings)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      for (const [opening, count] of sortedOpenings) {
        context += `  - ${opening}: ${count} game${count > 1 ? 's' : ''}\n`;
      }
      context += '\n';
    }

    // Sample of recent games (PGN excerpts)
    context += `=== RECENT GAMES (most recent first) ===\n\n`;
    games.slice(0, 5).forEach((game, i) => {
      const date = game.createdAt instanceof Date
        ? game.createdAt.toLocaleDateString()
        : game.date || 'Unknown';

      context += `--- Game ${i + 1} ---\n`;
      context += `${game.whitePlayer} vs ${game.blackPlayer}\n`;
      context += `Result: ${game.result} | Player was: ${game.userColor}\n`;
      context += `Date: ${date}\n`;
      if (game.opening) context += `Opening: ${game.opening}\n`;
      context += `Accuracy: White ${game.accuracy?.white?.toFixed(1) || '?'}%, Black ${game.accuracy?.black?.toFixed(1) || '?'}%\n`;

      // Count mistakes in this game
      const gameMistakes = { inaccuracy: 0, mistake: 0, blunder: 0 };
      if (game.moveClassifications) {
        game.moveClassifications.forEach(c => {
          if (c?.symbol === '?!') gameMistakes.inaccuracy++;
          if (c?.symbol === '?') gameMistakes.mistake++;
          if (c?.symbol === '??') gameMistakes.blunder++;
        });
      }
      context += `Mistakes: ${gameMistakes.inaccuracy} inaccuracies, ${gameMistakes.mistake} mistakes, ${gameMistakes.blunder} blunders\n`;

      // Include truncated PGN (moves only, no headers)
      const movesOnly = game.pgn.replace(/\[.*?\]\s*/g, '').trim();
      context += `Moves: ${movesOnly.substring(0, 500)}${movesOnly.length > 500 ? '...' : ''}\n\n`;
    });

    return context;
  },

  // Aggregate statistics from games
  aggregateStats(games) {
    const stats = {
      avgAccuracy: { white: 0, black: 0 },
      mistakes: { inaccuracy: 0, mistake: 0, blunder: 0 },
      results: { wins: 0, draws: 0, losses: 0 },
      openings: {}
    };

    let whiteCount = 0, blackCount = 0;

    games.forEach(game => {
      // Accuracy
      if (game.accuracy?.white !== null && game.accuracy?.white !== undefined) {
        stats.avgAccuracy.white += game.accuracy.white;
        whiteCount++;
      }
      if (game.accuracy?.black !== null && game.accuracy?.black !== undefined) {
        stats.avgAccuracy.black += game.accuracy.black;
        blackCount++;
      }

      // Mistakes
      if (game.moveClassifications) {
        game.moveClassifications.forEach(c => {
          if (c?.symbol === '?!') stats.mistakes.inaccuracy++;
          if (c?.symbol === '?') stats.mistakes.mistake++;
          if (c?.symbol === '??') stats.mistakes.blunder++;
        });
      }

      // Results
      const userWon = (game.userColor === 'white' && game.result === '1-0') ||
                      (game.userColor === 'black' && game.result === '0-1');
      const userLost = (game.userColor === 'white' && game.result === '0-1') ||
                       (game.userColor === 'black' && game.result === '1-0');

      if (userWon) stats.results.wins++;
      else if (userLost) stats.results.losses++;
      else if (game.result === '1/2-1/2') stats.results.draws++;

      // Openings
      if (game.opening) {
        stats.openings[game.opening] = (stats.openings[game.opening] || 0) + 1;
      }
    });

    stats.avgAccuracy.white = whiteCount > 0 ? stats.avgAccuracy.white / whiteCount : 0;
    stats.avgAccuracy.black = blackCount > 0 ? stats.avgAccuracy.black / blackCount : 0;

    return stats;
  },

  // Call the Claude API through our proxy
  async callCoachAPI(context, specificQuestion = null) {
    const userMessage = specificQuestion
      ? `${context}\n\n=== USER QUESTION ===\n${specificQuestion}`
      : `${context}\n\nPlease analyze my chess play and provide personalized coaching advice based on these games.`;

    const messages = [{
      role: 'user',
      content: userMessage
    }];

    try {
      const idToken = await AuthModule.currentUser.getIdToken();

      const response = await fetch(`${this.WORKER_URL}/api/coach`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          systemPrompt: this.getSystemPrompt(),
          messages: messages
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Coach API error:', response.status, errorText);

        if (response.status === 401) {
          showError('Authentication failed. Please sign in again.');
          return null;
        }
        if (response.status === 429) {
          showError('Rate limit reached. Please try again later.');
          return null;
        }

        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      const coachingResponse = data.content?.[0]?.text || data.text || 'No response received.';

      // Save coaching session
      await this.saveCoachingSession(context.substring(0, 1000), coachingResponse, specificQuestion);

      // Increment usage
      await this.incrementUsage();

      return coachingResponse;
    } catch (error) {
      console.error('AI Coach error:', error);
      showError('Failed to get coaching advice. Please try again.');
      return null;
    }
  },

  // Check free tier usage limits
  async checkUsageLimits() {
    const userId = AuthModule.currentUser.uid;

    try {
      const userDoc = await db.collection('users').doc(userId).get();
      const userData = userDoc.data();

      // Premium users have no limits
      if (userData?.subscription?.tier === 'premium') {
        return true;
      }

      // Check daily usage for free tier
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const usageRef = db.collection('users').doc(userId).collection('usage').doc(today);
      const usageDoc = await usageRef.get();
      const usage = usageDoc.data() || { coachingSessions: 0 };

      const FREE_DAILY_LIMIT = 3;
      return usage.coachingSessions < FREE_DAILY_LIMIT;
    } catch (error) {
      console.error('Error checking usage limits:', error);
      return true; // Allow on error to avoid blocking users
    }
  },

  // Increment usage counter
  async incrementUsage() {
    const userId = AuthModule.currentUser.uid;
    const today = new Date().toISOString().split('T')[0];
    const usageRef = db.collection('users').doc(userId).collection('usage').doc(today);

    try {
      await usageRef.set({
        coachingSessions: firebase.firestore.FieldValue.increment(1),
        lastUsed: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (error) {
      console.error('Error incrementing usage:', error);
    }
  },

  // Save coaching session to Firestore
  async saveCoachingSession(contextSummary, response, question = null) {
    const userId = AuthModule.currentUser.uid;

    try {
      await db.collection('users').doc(userId).collection('coachingSessions').add({
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        contextSummary: contextSummary,
        question: question,
        response: response,
        gamesCount: GameStorage.userGames.length
      });
    } catch (error) {
      console.error('Error saving coaching session:', error);
    }
  },

  // Show upgrade prompt for free tier limit
  showUpgradePrompt() {
    const panel = document.getElementById('coach-response');
    if (panel) {
      panel.innerHTML = `
        <div class="upgrade-prompt">
          <h4>Daily Limit Reached</h4>
          <p>You've used your 3 free AI coaching sessions for today.</p>
          <p>Upgrade to Premium for unlimited coaching advice!</p>
          <button onclick="PaymentsModule.showUpgradeModal()" class="upgrade-btn">
            Upgrade to Premium
          </button>
        </div>
      `;
    }
  },

  // Toggle coach panel visibility
  togglePanel() {
    this.isPanelOpen = !this.isPanelOpen;
    const panel = document.getElementById('coach-panel');
    if (panel) {
      panel.style.display = this.isPanelOpen ? 'block' : 'none';
    }
  },

  // Update coach UI
  updateCoachUI() {
    const responseDiv = document.getElementById('coach-response');
    const analyzeBtn = document.getElementById('coach-analyze-btn');
    const questionInput = document.getElementById('coach-question');
    const askBtn = document.getElementById('coach-ask-btn');

    if (this.isAnalyzing) {
      if (responseDiv) {
        responseDiv.innerHTML = `
          <div class="coach-loading">
            <div class="loading-spinner"></div>
            <p>Analyzing your games...</p>
            <p class="loading-subtext">This may take a moment.</p>
          </div>
        `;
      }
      if (analyzeBtn) analyzeBtn.disabled = true;
      if (askBtn) askBtn.disabled = true;
      if (questionInput) questionInput.disabled = true;
    } else {
      if (analyzeBtn) analyzeBtn.disabled = false;
      if (askBtn) askBtn.disabled = false;
      if (questionInput) questionInput.disabled = false;

      if (this.currentResponse && responseDiv) {
        // Convert markdown-style formatting to HTML
        const formattedResponse = this.formatResponse(this.currentResponse);
        responseDiv.innerHTML = `<div class="coach-advice">${formattedResponse}</div>`;
      }
    }
  },

  // Format the response with basic markdown support
  formatResponse(text) {
    return text
      // Headers
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Line breaks
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      // Wrap in paragraphs
      .replace(/^/, '<p>')
      .replace(/$/, '</p>');
  }
};

// Global functions for onclick handlers
function toggleCoachPanel() {
  AICoach.togglePanel();
}

function analyzeMyGames() {
  AICoach.analyzeGameDatabase();
}

function askCoachQuestion() {
  const input = document.getElementById('coach-question');
  if (input) {
    AICoach.askQuestion(input.value);
    input.value = '';
  }
}
