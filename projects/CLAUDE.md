# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a multi-project portfolio containing 4 web applications focused on data visualization and interactive tools. The main production project is "All In" (a Tesla stock tracker).

## Projects

### All-In Stock Tracker (`all-in/`)
React + Vite application for real-time Tesla stock price tracking with charting. Production-ready, deployed to GitHub Pages.

**Commands:**
```bash
cd all-in
npm install          # Install dependencies
npm run dev          # Start dev server (localhost:5173)
npm run build        # Production build to dist/
npm run preview      # Preview production build
```

**Architecture:**
- Multi-entry Vite build: `index.html` (main app) and `tsla.html` (news app)
- Backend: Cloudflare Worker at `https://dry-poetry-72b5.donovanh59.workers.dev`
- Deployed via GitHub Actions to GitHub Pages (auto-deploys on push to main)

**Data Sources:**
- Yahoo Finance: OHLCV data, quotes, 52-week range, pre/post prices
- Alpaca: Extended hours bars, market clock/status
- FMP: Shares outstanding
- Finnhub: Real-time prices via WebSocket, forward P/E

**Key Files:**
- `src/components/StockTracker.jsx` - Main component (state, data fetching, rendering)
- `src/components/StockChart.jsx` - Chart visualization
- `src/utils/api.js` - Data fetching logic
- `src/utils/marketState.js` - Market hours detection (pre-market, open, after-hours, closed)
- `src/utils/cache.js` - LocalStorage caching

**Technical Notes:**
- All market times are EST (America/New_York timezone)
- Uses dayjs for timezone-aware date handling
- Mobile breakpoint at 700px
- WebSocket reconnection logic for real-time price updates

### Chess Analysis (`chess/`)
Vanilla JS chess game analysis with Stockfish WASM integration.

### Car Comparison (`carCompare/`)
Vanilla JS performance car comparison tool. Uses Anthropic API (Claude) for data population.

### Road Trip Planner (`roadtrip/`)
Vanilla JS route planning with 3D globe visualization. In design phase.

## Development Notes

Each project has a `notes.txt` file with development roadmap and known issues:
- `all-in/all-inNotes.txt` - Active development notes, bugs, planned features
- `chess/notes.txt` - Version history and roadmap
- `carCompare/notes.txt` - LLM data pipeline documentation
- `roadtrip/notes.txt` - Design planning
