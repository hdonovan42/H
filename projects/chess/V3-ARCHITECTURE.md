# Chess Analysis V3 - Architecture Documentation

## Overview

V3 transforms the chess analysis tool from a standalone client-side application into a full-stack platform with user accounts, cloud storage, AI coaching, and multiple analysis engines.

### New Features

| Feature | Description |
|---------|-------------|
| User Authentication | Google/Email sign-in via Firebase Auth |
| Game Storage | Save analyzed games to Firestore cloud database |
| Dark Mode | Theme toggle with CSS variables, persists to localStorage |
| Auto-flip Board | Detects user color from PGN headers, orients board accordingly |
| Material Display | Shows captured pieces and point advantage as board overlay |
| Lichess Cloud Engine | Alternative to local Stockfish (~depth 22, rate-limited) |
| AI Chess Coach | Personalized coaching advice via Claude API |
| Mobile Support | Responsive layout with touch navigation |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              BROWSER                                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                        analysis.html                             │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │    │
│  │  │ Auth UI  │ │  Board   │ │ Analysis │ │   Coach Panel    │   │    │
│  │  │  Header  │ │ + Arrows │ │  + Graph │ │   + Games List   │   │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                      JavaScript Modules                          │    │
│  │                                                                   │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │    │
│  │  │ script.js   │  │ auth.js     │  │ game-storage.js         │  │    │
│  │  │ (core app)  │  │ (Firebase   │  │ (save/load games)       │  │    │
│  │  │             │  │  Auth)      │  │                         │  │    │
│  │  └─────────────┘  └─────────────┘  └─────────────────────────┘  │    │
│  │                                                                   │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │    │
│  │  │ material.js │  │ lichess-    │  │ ai-coach.js             │  │    │
│  │  │ (captured   │  │ api.js      │  │ (Claude API client)     │  │    │
│  │  │  pieces)    │  │ (cloud eng) │  │                         │  │    │
│  │  └─────────────┘  └─────────────┘  └─────────────────────────┘  │    │
│  │                                                                   │    │
│  │  ┌─────────────────────────────────────────────────────────────┐│    │
│  │  │ firebase-config.js (Firebase initialization)                ││    │
│  │  └─────────────────────────────────────────────────────────────┘│    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌──────────────────┐                                                   │
│  │ Web Workers      │                                                   │
│  │ ┌──────────────┐ │                                                   │
│  │ │ Stockfish    │ │  (WASM chess engine running in background)        │
│  │ │ Lite / Full  │ │                                                   │
│  │ └──────────────┘ │                                                   │
│  └──────────────────┘                                                   │
└─────────────────────────────────────────────────────────────────────────┘
           │                    │                       │
           │                    │                       │
           ▼                    ▼                       ▼
┌──────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐
│   Firebase       │  │  Lichess API    │  │  Cloudflare Worker          │
│                  │  │                 │  │  (chess-coach)              │
│  ┌────────────┐  │  │  GET /cloud-eval│  │                             │
│  │ Auth       │  │  │                 │  │  POST /api/coach            │
│  │ (users)    │  │  │  Returns:       │  │    │                        │
│  └────────────┘  │  │  - depth ~22    │  │    ▼                        │
│                  │  │  - eval score   │  │  ┌─────────────────────┐    │
│  ┌────────────┐  │  │  - best lines   │  │  │ Verify Firebase     │    │
│  │ Firestore  │  │  │                 │  │  │ ID Token            │    │
│  │ (games,    │  │  │  Rate limit:    │  │  └──────────┬──────────┘    │
│  │  sessions, │  │  │  1 req/sec      │  │             │               │
│  │  usage)    │  │  │                 │  │             ▼               │
│  └────────────┘  │  │                 │  │  ┌─────────────────────┐    │
│                  │  │                 │  │  │ Forward to Claude   │    │
└──────────────────┘  └─────────────────┘  │  │ API with API key    │    │
                                           │  └──────────┬──────────┘    │
                                           │             │               │
                                           │             ▼               │
                                           │  ┌─────────────────────┐    │
                                           │  │ Return coaching     │    │
                                           │  │ response            │    │
                                           │  └─────────────────────┘    │
                                           └─────────────────────────────┘
                                                         │
                                                         ▼
                                           ┌─────────────────────────────┐
                                           │  Anthropic Claude API       │
                                           │  (api.anthropic.com)        │
                                           │                             │
                                           │  Model: claude-sonnet-4-20250514     │
                                           │  Max tokens: 2048           │
                                           └─────────────────────────────┘
```

---

## Module Breakdown

### Core Application

#### `script.js` (2000+ lines)
The main application logic, unchanged from v2 except for integrations:

- **AppState**: Global state object (board, game, engine, eval history, etc.)
- **initializeApp()**: Now also initializes ThemeManager and AuthModule
- **updateDisplay()**: Now also calls MaterialDisplay.render()
- **updateStockfishAnalysis()**: Now routes to cloud engine if selected
- **loadPGN()**: Now auto-flips board based on detected user color
- **ThemeManager**: New object for dark mode toggle

#### `styles.css`
Now uses CSS variables for theming:

```css
:root {
  --bg-primary: #FFF1E5;
  --text-primary: #333333;
  /* ... */
}

[data-theme="dark"] {
  --bg-primary: #1a1a2e;
  --text-primary: #e0e0e0;
  /* ... */
}
```

---

### Authentication & Storage

#### `firebase-config.js`
Initializes Firebase with your project credentials:

```javascript
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
```

#### `auth.js` - AuthModule
Handles user authentication:

| Method | Description |
|--------|-------------|
| `init()` | Sets up auth state listener |
| `signInWithGoogle()` | Google popup sign-in |
| `signInWithEmail(email, password)` | Email/password sign-in |
| `signUpWithEmail(email, password)` | Create new account |
| `signOut()` | Sign out |
| `updateUI(user)` | Toggle auth/user-info visibility |
| `loadUserSettings(userId)` | Load theme and preferences from Firestore |

#### `game-storage.js` - GameStorage
Manages game persistence:

| Method | Description |
|--------|-------------|
| `saveGame()` | Save current game to Firestore |
| `loadUserGames(userId)` | Load user's game history |
| `loadSavedGame(gameId)` | Load a game into the analysis board |
| `deleteGame(gameId)` | Delete a saved game |
| `extractPGNHeaders(pgn)` | Parse PGN headers (White, Black, Result, etc.) |
| `detectUserColor(headers)` | Determine if user played white or black |
| `updateUserStats(gameData)` | Update running accuracy statistics |

---

### Analysis Features

#### `material.js` - MaterialDisplay
Calculates and displays material advantage:

| Method | Description |
|--------|-------------|
| `calculateMaterial(fen)` | Count pieces for each side |
| `getMaterialDifference(fen)` | Return point difference (+ = white ahead) |
| `getCapturedPieces(fen)` | Return which pieces have been captured |
| `render()` | Update the material display overlay |

Displayed as semi-transparent overlay at top of board showing captured pieces and point advantage.

#### `lichess-api.js` - LichessAPI
Alternative cloud-based analysis engine:

| Method | Description |
|--------|-------------|
| `getCloudEval(fen, multiPv)` | Fetch cloud evaluation for position |
| `queueRequest(url)` | Rate-limited request queue (1 req/sec) |
| `parseCloudEval(data)` | Convert Lichess format to AppState format |
| `toMultipvResults(cloudEval, turn)` | Convert to multipvResults format |

**Limitations:**
- Only works for positions in Lichess's database (common openings, popular games)
- Falls back to local Stockfish if position not found
- Rate limited to 1 request per second

---

### AI Chess Coach

#### `ai-coach.js` - AICoach
Frontend module for Claude API coaching:

| Method | Description |
|--------|-------------|
| `analyzeGameDatabase()` | Analyze user's saved games and get coaching |
| `askQuestion(question)` | Ask a specific coaching question |
| `buildAnalysisContext(games)` | Format games for Claude prompt |
| `aggregateStats(games)` | Calculate accuracy, mistakes, win rate |
| `callCoachAPI(context, question)` | Make API call through worker proxy |
| `checkUsageLimits()` | Check free tier daily limit (3/day) |
| `saveCoachingSession(...)` | Store session in Firestore |

#### `worker/index.js` - Cloudflare Worker
Backend proxy for Claude API:

```
POST /api/coach
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "systemPrompt": "You are a chess coach...",
  "messages": [{ "role": "user", "content": "..." }]
}
```

**Why a proxy?**
- API keys cannot be exposed in client-side JavaScript
- Worker stores ANTHROPIC_API_KEY as secret environment variable
- Verifies Firebase ID token before forwarding request
- Handles rate limiting and errors

---

## AI Coach Data Flow

```
1. User clicks "Analyze My Games"
   │
   ▼
2. AICoach.analyzeGameDatabase()
   │
   ├── Get user's games from GameStorage.userGames
   │
   ├── Build context with aggregateStats():
   │   - Average accuracy (white/black)
   │   - Mistake counts (inaccuracy/mistake/blunder)
   │   - Win/draw/loss record
   │   - Opening repertoire
   │   - Sample PGNs from recent games
   │
   ▼
3. callCoachAPI(context)
   │
   ├── Get Firebase ID token: AuthModule.currentUser.getIdToken()
   │
   ├── POST to Cloudflare Worker:
   │   {
   │     systemPrompt: "You are an expert chess coach...",
   │     messages: [{ role: "user", content: context }]
   │   }
   │
   ▼
4. Cloudflare Worker (worker/index.js)
   │
   ├── Verify Firebase token
   │
   ├── Forward to Claude API:
   │   POST https://api.anthropic.com/v1/messages
   │   x-api-key: [SECRET]
   │   {
   │     model: "claude-sonnet-4-20250514",
   │     max_tokens: 2048,
   │     system: systemPrompt,
   │     messages: messages
   │   }
   │
   ▼
5. Claude generates coaching response
   │
   ├── Analyzes player statistics
   ├── Identifies patterns and weaknesses
   ├── Provides actionable recommendations
   │
   ▼
6. Response flows back:
   Claude → Worker → Browser → AICoach.updateCoachUI()
   │
   ▼
7. AICoach saves session to Firestore and increments usage counter
```

---

## Firestore Data Schema

```
/users/{userId}
│
├── email: string
├── displayName: string
├── createdAt: timestamp
│
├── settings: {
│     theme: "light" | "dark"
│     defaultEngine: "lite" | "full" | "cloud"
│     autoFlipBoard: boolean
│     analysisDepth: number
│   }
│
├── subscription: {
│     tier: "free" | "premium"
│     expiresAt: timestamp | null
│   }
│
├── stats: {
│     gamesAnalyzed: number
│     averageAccuracy: { white: number, black: number }
│     commonMistakeTypes: { inaccuracy, mistake, blunder }
│   }
│
├── /games/{gameId}
│   ├── pgn: string
│   ├── createdAt: timestamp
│   ├── whitePlayer: string
│   ├── blackPlayer: string
│   ├── result: "1-0" | "0-1" | "1/2-1/2" | "*"
│   ├── userColor: "white" | "black" | "unknown"
│   ├── opening: string
│   ├── accuracy: { white: number, black: number }
│   ├── moveClassifications: array
│   ├── evalHistory: array
│   └── analysisDepth: number
│
├── /coachingSessions/{sessionId}
│   ├── createdAt: timestamp
│   ├── contextSummary: string
│   ├── question: string | null
│   ├── response: string
│   └── gamesCount: number
│
└── /usage/{date}  (e.g., "2025-01-03")
    ├── coachingSessions: number
    └── lastUsed: timestamp
```

---

## File Structure

```
/projects/chess/
├── analysis.html          # Main HTML with auth UI, panels, mobile nav
├── css/
│   ├── styles.css         # CSS variables, dark mode, responsive styles
│   └── chessboard-1.0.0.min.css
├── js/
│   ├── script.js          # Core app (ThemeManager added)
│   ├── firebase-config.js # Firebase initialization [NEW]
│   ├── auth.js            # Authentication module [NEW]
│   ├── game-storage.js    # Game persistence [NEW]
│   ├── material.js        # Material display [NEW]
│   ├── lichess-api.js     # Cloud engine [NEW]
│   ├── ai-coach.js        # AI coaching [NEW]
│   ├── chessboard-1.0.0.min.js
│   ├── stockfish-17-lite-single.js
│   ├── stockfish-17-lite-single.wasm
│   ├── stockfish-17-single.js
│   └── stockfish-17-single-part-*.wasm (6 files)
├── worker/                 # Cloudflare Worker [NEW]
│   ├── index.js           # Worker code
│   ├── wrangler.toml      # Deployment config
│   └── README.md          # Deployment instructions
├── img/
│   └── chesspieces/wikipedia/
├── notes.txt
└── V3-ARCHITECTURE.md     # This file
```

---

## Setup Instructions

### 1. Firebase Setup

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create a new project
3. Enable Authentication:
   - Go to Authentication → Sign-in method
   - Enable Google and Email/Password
4. Create Firestore Database:
   - Go to Firestore Database → Create database
   - Start in production mode
   - Add security rules (see below)
5. Get config:
   - Go to Project Settings → General → Your apps
   - Click "Add app" → Web
   - Copy the config object

6. Update `js/firebase-config.js`:
```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

7. Set Firestore security rules:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      match /{subcollection}/{docId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

### 2. Cloudflare Worker Setup

1. Install Wrangler CLI:
```bash
npm install -g wrangler
```

2. Login to Cloudflare:
```bash
wrangler login
```

3. Navigate to worker directory:
```bash
cd projects/chess/worker
```

4. Set secrets:
```bash
wrangler secret put ANTHROPIC_API_KEY
# Paste your Anthropic API key when prompted

wrangler secret put FIREBASE_PROJECT_ID
# Paste your Firebase project ID when prompted
```

5. Deploy:
```bash
wrangler deploy
```

6. Note your worker URL (output will show):
```
https://chess-coach.YOUR_SUBDOMAIN.workers.dev
```

7. Update `js/ai-coach.js`:
```javascript
WORKER_URL: 'https://chess-coach.YOUR_SUBDOMAIN.workers.dev',
```

---

## Feature Availability

| Feature | Free Tier | Premium |
|---------|-----------|---------|
| Local Stockfish analysis | Unlimited | Unlimited |
| Lichess cloud engine | Unlimited | Unlimited |
| Game storage | 50 games | Unlimited |
| AI coaching sessions | 3/day | Unlimited |
| Dark mode | Yes | Yes |
| Auto-flip board | Yes | Yes |
| Material display | Yes | Yes |

---

## Known Limitations

1. **Lichess Cloud Engine**: Only works for positions in their database (common openings). Falls back to local engine for novel positions.

2. **Firebase Token Verification**: The worker uses simplified JWT decoding. For production, implement full verification with Firebase Admin SDK.

3. **Mobile Touch**: Two-tap piece movement not yet implemented. Currently relies on drag-drop which can be awkward on mobile.

4. **Payments**: Stripe integration is planned but not implemented. Premium tier currently has no payment flow.
