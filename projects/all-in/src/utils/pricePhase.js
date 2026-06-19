import { MarketState } from './marketState';

// Regular-session price phase — the single source of truth all views read from.
//
//   live (green)  →  settling (amber)  →  settled (red)
//   live tick        poll until stable     locked official close
//
// `inert` covers pre-market / overnight / weekend / holiday: no "today" row,
// red light, box shows the last regular-session price, no settle poll.
export const PHASE = {
  LIVE: 'live',
  SETTLING: 'settling',
  SETTLED: 'settled',
  INERT: 'inert'
};

const MARKET_CLOSE_MIN = 16 * 60; // 4:00 PM EST, minutes from midnight

// Decide the phase from market state on a cold load (page opened, not a witnessed
// OPEN→close transition). Crucially: an evening visitor must land on `settled`
// with no amber flash — only someone arriving within `coldWindowMin` of the bell
// (or who witnesses the live transition) sees `settling`.
export const determineInitialPhase = ({ marketState, coldWindowMin }) => {
  if (!marketState) return PHASE.INERT;

  if (marketState.state === MarketState.OPEN) return PHASE.LIVE;

  if (marketState.state === MarketState.POST_MARKET) {
    const minsSinceClose = marketState.timeInMinutes - MARKET_CLOSE_MIN;
    return minsSinceClose <= coldWindowMin ? PHASE.SETTLING : PHASE.SETTLED;
  }

  // PRE_MARKET, CLOSED (overnight/weekend/holiday). Half-day early closes land in
  // CLOSED here and fall through to inert on cold load — the witnessed-transition
  // path still settles them correctly (known cold-load limitation).
  return PHASE.INERT;
};

// True once the last K readings are all equal at cent precision. Reading values
// are rounded to integer cents to dodge float noise.
export const isStable = (readings, K) => {
  if (!Array.isArray(readings) || readings.length < K) return false;
  const tail = readings.slice(-K).map(v => Math.round(v * 100));
  return tail.every(v => v === tail[0]);
};

// The one resolved number every view renders (box, spreadsheet today-close, chart).
// Dedicated settling/settled values take priority so a frozen `quote.c` (last live
// tick) can never resurface post-close; everything else falls back to the live quote.
export const resolvePrice = ({ phase, quote, settlingValue, settledValue, dataLastClose }) => {
  const live = quote?.c ?? dataLastClose ?? 0;
  if (phase === PHASE.SETTLING) return settlingValue ?? live;
  if (phase === PHASE.SETTLED) return settledValue ?? live;
  return live; // live + inert
};
