export const WORKER_URL = 'https://dry-poetry-72b5.donovanh59.workers.dev';
export const CACHE_DURATION = 60 * 60 * 1000; // 1 hour
export const EST = 'America/New_York';
export const EARNINGS_DATE = '2026-04-22';
export const EARNINGS_TIME = 'aftermarket';

// Close-settle tuning: after market close we poll Yahoo's regularMarketPrice
// until it stabilises (the official auction close settles a few minutes after 16:00),
// then lock every view to it. See src/utils/pricePhase.js.
export const SETTLE_POLL_INTERVAL_MS = 15 * 1000;   // poll cadence while settling
export const SETTLE_STABLE_K = 3;                   // consecutive cent-equal reads = settled
export const SETTLE_TIMEOUT_MS = 15 * 60 * 1000;    // backstop: lock last value after 15 min
export const SETTLE_COLD_WINDOW_MIN = 10;           // cold-load within N min of close still settles live
