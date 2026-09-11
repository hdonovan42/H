import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { EST } from './config';

dayjs.extend(utc);
dayjs.extend(timezone);

export const MarketState = {
  PRE_MARKET: 'pre-market',
  OPEN: 'open',
  POST_MARKET: 'post-market',
  CLOSED: 'closed'
};

// Time constants (in minutes from midnight)
const PRE_MARKET_START = 4 * 60;    // 4:00 AM
const MARKET_OPEN = 9 * 60 + 30;    // 9:30 AM
const MARKET_CLOSE = 16 * 60;       // 4:00 PM
const POST_MARKET_END = 20 * 60;    // 8:00 PM

// Get market state using local time calculation (fallback)
const getLocalMarketState = (now) => {
  const day = now.day();
  const timeInMinutes = now.hour() * 60 + now.minute();
  const isWeekend = day === 0 || day === 6;

  let state;

  if (isWeekend) {
    state = MarketState.CLOSED;
  } else if (timeInMinutes >= MARKET_OPEN && timeInMinutes < MARKET_CLOSE) {
    state = MarketState.OPEN;
  } else if (timeInMinutes >= PRE_MARKET_START && timeInMinutes < MARKET_OPEN) {
    state = MarketState.PRE_MARKET;
  } else if (timeInMinutes >= MARKET_CLOSE && timeInMinutes < POST_MARKET_END) {
    state = MarketState.POST_MARKET;
  } else {
    state = MarketState.CLOSED;
  }

  return { state, isWeekend, timeInMinutes };
};

// Did a regular session actually trade today? Alpaca's clock cannot answer this after
// the bell (on a holiday and after a normal close, next_open is tomorrow either way),
// so fall back to the data: once the session has started, Yahoo carries a daily bar
// dated today. `openSeenDate` is the last date the clock reported the market open, so
// a page that witnessed the session never has to ask. Returns true / false / null.
export const hasTradedToday = ({ clockData = null, bars = [], openSeenDate = null } = {}) => {
  const now = dayjs().tz(EST);
  const today = now.format('YYYY-MM-DD');

  if (clockData?.isOpen || openSeenDate === today) return true;
  if (now.hour() * 60 + now.minute() < MARKET_OPEN) return false;
  if (!bars.length) return null; // unknown until the daily bars arrive

  return String(bars[bars.length - 1].date).slice(0, 10) === today;
};

// The regular session the page is showing: today once it has traded, otherwise the
// latest completed session in the daily bars. Every session-dependent number hangs off
// this one date — previous close, day range, today's row, the 1D chart — so none of
// them can outlive the session it was fetched for. A bar Yahoo dates today before the
// session has started is premature and ignored.
export const getSessionDate = ({ bars = [], tradedToday = false } = {}) => {
  const today = dayjs().tz(EST).format('YYYY-MM-DD');
  if (tradedToday) return today;

  const earlier = bars.map(b => String(b.date).slice(0, 10)).filter(d => d < today);
  return earlier.length ? earlier[earlier.length - 1] : null;
};

// Get market state - uses clock data if provided, otherwise falls back to local calculation
// `tradedToday` (see hasTradedToday) resolves post-bell holidays; omit it and a weekday
// evening is assumed to be a normal post-market, which is right far more often than not.
export const getMarketState = (clockData = null, { tradedToday = null } = {}) => {
  const now = dayjs().tz(EST);
  const local = getLocalMarketState(now);

  // If no clock data, use local calculation only
  if (!clockData) {
    return {
      state: local.state,
      estTime: now,
      isWeekend: local.isWeekend,
      timeInMinutes: local.timeInMinutes,
      isRegularHours: local.state === MarketState.OPEN,
      isExtendedHours: local.state === MarketState.PRE_MARKET || local.state === MarketState.POST_MARKET,
      isTradingPossible: local.state !== MarketState.CLOSED,
      isHoliday: false,
      usingApi: false
    };
  }

  // Use Alpaca clock data for accurate market status
  const { isOpen, nextOpen, nextClose } = clockData;

  // Holiday = a weekday with no session. Before the bell next_open answers exactly.
  // After it, next_open is tomorrow on a holiday AND after a normal close, so only
  // `tradedToday` can tell them apart (the old `next_open !== today` test made every
  // weekday evening a holiday, so POST_MARKET never happened).
  const todayStr = now.format('YYYY-MM-DD');
  const nextOpenStr = nextOpen ? dayjs(nextOpen).tz(EST).format('YYYY-MM-DD') : null;
  const isHoliday = !local.isWeekend && !isOpen && (local.timeInMinutes < MARKET_OPEN
    ? nextOpenStr !== todayStr
    : tradedToday === false);

  let state;

  if (isHoliday || local.isWeekend) {
    // Holiday or weekend - market fully closed
    state = MarketState.CLOSED;
  } else if (isOpen) {
    // API confirms market is open
    state = MarketState.OPEN;
  } else if (local.timeInMinutes >= PRE_MARKET_START && local.timeInMinutes < MARKET_OPEN) {
    // Pre-market hours (API doesn't track this, use local)
    state = MarketState.PRE_MARKET;
  } else if (local.timeInMinutes >= MARKET_CLOSE && local.timeInMinutes < POST_MARKET_END) {
    // Post-market hours (API doesn't track this, use local)
    state = MarketState.POST_MARKET;
  } else {
    state = MarketState.CLOSED;
  }

  return {
    state,
    estTime: now,
    isWeekend: local.isWeekend,
    timeInMinutes: local.timeInMinutes,
    isRegularHours: state === MarketState.OPEN,
    isExtendedHours: state === MarketState.PRE_MARKET || state === MarketState.POST_MARKET,
    isTradingPossible: state !== MarketState.CLOSED,
    isHoliday,
    usingApi: true,
    nextOpen,
    nextClose
  };
};

export const getTodayEST = () => {
  return dayjs().tz(EST).format('YYYY-MM-DD');
};

export { dayjs };
