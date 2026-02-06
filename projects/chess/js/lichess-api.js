// Lichess Cloud Engine API Module
const LichessAPI = {
  baseUrl: 'https://lichess.org/api',
  requestQueue: [],
  isProcessing: false,
  lastRequestTime: 0,
  minRequestInterval: 1000, // 1 second between requests (Lichess rate limit)

  // Get cloud evaluation for a position
  async getCloudEval(fen, multiPv = 3) {
    const encodedFen = encodeURIComponent(fen);
    const url = `${this.baseUrl}/cloud-eval?fen=${encodedFen}&multiPv=${multiPv}`;

    return this.queueRequest(url);
  },

  // Rate-limited request queue
  queueRequest(url) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ url, resolve, reject });
      this.processQueue();
    });
  },

  // Process queued requests with rate limiting
  async processQueue() {
    if (this.isProcessing || this.requestQueue.length === 0) return;

    this.isProcessing = true;

    // Wait if we're making requests too fast
    const timeSinceLastRequest = Date.now() - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      await new Promise(r => setTimeout(r, this.minRequestInterval - timeSinceLastRequest));
    }

    const { url, resolve, reject } = this.requestQueue.shift();

    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json'
        }
      });

      if (response.status === 429) {
        // Rate limited - wait and retry
        console.warn('Lichess rate limit hit, waiting 60s...');
        await new Promise(r => setTimeout(r, 60000));
        this.requestQueue.unshift({ url, resolve, reject });
        this.isProcessing = false;
        this.processQueue();
        return;
      }

      if (response.status === 404) {
        // Position not in cloud database
        console.log('Position not in Lichess cloud database');
        resolve(null);
      } else if (response.ok) {
        const data = await response.json();
        resolve(this.parseCloudEval(data));
      } else {
        console.error(`Lichess API error: ${response.status}`);
        reject(new Error(`Lichess API error: ${response.status}`));
      }
    } catch (error) {
      console.error('Lichess API request failed:', error);
      reject(error);
    } finally {
      this.lastRequestTime = Date.now();
      this.isProcessing = false;
      // Process next request in queue
      if (this.requestQueue.length > 0) {
        setTimeout(() => this.processQueue(), 100);
      }
    }
  },

  // Parse Lichess cloud eval response to match AppState format
  parseCloudEval(data) {
    if (!data || !data.pvs || data.pvs.length === 0) {
      return null;
    }

    return {
      depth: data.depth,
      knodes: data.knodes,
      fen: data.fen,
      pvs: data.pvs.map((pv, index) => ({
        multipv: index + 1,
        moves: pv.moves,
        score: pv.cp !== undefined ? (pv.cp / 100) : null,
        mate: pv.mate !== undefined ? pv.mate : undefined,
        scoreDisplay: pv.mate !== undefined
          ? `Mate in ${Math.abs(pv.mate)}`
          : pv.cp !== undefined
            ? (pv.cp / 100).toFixed(2)
            : '?'
      }))
    };
  },

  // Convert cloud eval to AppState.multipvResults format
  toMultipvResults(cloudEval, currentTurn) {
    if (!cloudEval) return null;

    const results = {};

    cloudEval.pvs.forEach((pv, index) => {
      let score = pv.score;
      let mate = pv.mate;

      // Adjust for side to move (Lichess returns from white's perspective)
      if (currentTurn === 'b') {
        if (score !== null) score = -score;
        if (mate !== undefined) mate = -mate;
      }

      results[index + 1] = {
        depth: cloudEval.depth,
        score: score !== null ? score.toFixed(2) : null,
        mate: mate,
        pv: pv.moves,
        multipv: index + 1,
        scoreDisplay: mate !== undefined
          ? `Mate in ${Math.abs(mate)}`
          : score !== null
            ? score.toFixed(2)
            : '?'
      };
    });

    return results;
  },

  // Check if we can use cloud eval (not rate limited)
  canRequest() {
    return Date.now() - this.lastRequestTime >= this.minRequestInterval;
  },

  // Get queue length
  getQueueLength() {
    return this.requestQueue.length;
  },

  // Clear the queue
  clearQueue() {
    this.requestQueue.forEach(({ reject }) => {
      reject(new Error('Queue cleared'));
    });
    this.requestQueue = [];
  }
};

// Cloud analysis function to be called from main script
async function updateCloudAnalysis() {
  if (!AppState.engineEnabled || AppState.selectedEngine !== 'cloud') {
    return;
  }

  const fen = AppState.game.fen();
  AppState.isAnalysisInProgress = true;
  updateDisplay();

  try {
    const cloudEval = await LichessAPI.getCloudEval(fen);

    if (cloudEval) {
      // Convert to AppState format
      const results = LichessAPI.toMultipvResults(cloudEval, AppState.game.turn());

      if (results) {
        AppState.multipvResults = results;

        // Set best move
        if (cloudEval.pvs[0]?.moves) {
          const bestMove = cloudEval.pvs[0].moves.split(' ')[0];
          AppState.bestMoveInfo = { bestMove };
        }
      }
    } else {
      // Position not in cloud database - fall back to local engine
      console.log('Position not in Lichess cloud, falling back to local engine');

      // Temporarily switch to lite engine for this position
      const previousEngine = AppState.selectedEngine;
      AppState.selectedEngine = 'lite';

      // Make sure local engine is initialized
      if (!AppState.stockfish || !AppState.stockfishReady) {
        document.getElementById('stockfish-loading').style.display = 'block';
        initializeStockfish();
      } else {
        updateStockfishAnalysis();
      }

      // Show notice to user
      showCloudFallbackNotice();

      // Don't restore cloud selection - let user switch back manually
      return;
    }
  } catch (error) {
    console.error('Cloud analysis error:', error);
    // Fall back to local engine on error
    AppState.selectedEngine = 'lite';
    if (AppState.stockfish && AppState.stockfishReady) {
      updateStockfishAnalysis();
    }
  } finally {
    AppState.isAnalysisInProgress = false;
    updateDisplay();
  }
}

// Show notice when falling back from cloud
function showCloudFallbackNotice() {
  const outputDiv = document.getElementById('stockfish-output');
  if (outputDiv) {
    const notice = document.createElement('div');
    notice.className = 'cloud-fallback-notice';
    notice.innerHTML = `
      <p>Position not in Lichess cloud database.</p>
      <p>Switched to local Stockfish engine.</p>
    `;
    notice.style.cssText = `
      background-color: #fff3cd;
      color: #856404;
      padding: 8px;
      border-radius: 4px;
      margin-bottom: 10px;
      font-size: 12px;
    `;
    outputDiv.insertBefore(notice, outputDiv.firstChild);

    // Remove notice after 5 seconds
    setTimeout(() => {
      if (notice.parentNode) {
        notice.remove();
      }
    }, 5000);
  }
}
