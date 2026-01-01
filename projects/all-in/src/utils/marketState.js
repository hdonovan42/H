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

// Get market state - uses clock data if provided, otherwise falls back to local calculation
export const getMarketState = (clockData = null) => {
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

  // Determine if today is a holiday:
  // It's a weekday, during normal market hours, but API says market is closed
  const isHoliday = !local.isWeekend &&
    local.timeInMinutes >= MARKET_OPEN &&
    local.timeInMinutes < MARKET_CLOSE &&
    !isOpen;

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
