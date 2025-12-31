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

export const getMarketState = () => {
  const now = dayjs().tz(EST);
  const day = now.day();
  const timeInMinutes = now.hour() * 60 + now.minute();

  const isWeekend = day === 0 || day === 6;

  const PRE_MARKET_START = 4 * 60;
  const MARKET_OPEN = 9 * 60 + 30;
  const MARKET_CLOSE = 16 * 60;
  const POST_MARKET_END = 20 * 60;

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

  return {
    state,
    estTime: now,
    isWeekend,
    timeInMinutes,
    isRegularHours: state === MarketState.OPEN,
    isExtendedHours: state === MarketState.PRE_MARKET || state === MarketState.POST_MARKET,
    isTradingPossible: state !== MarketState.CLOSED
  };
};

export const getTodayEST = () => {
  return dayjs().tz(EST).format('YYYY-MM-DD');
};

export { dayjs };
