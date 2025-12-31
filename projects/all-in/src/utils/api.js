import { WORKER_URL } from './config';
import { dayjs, getMarketState, MarketState } from './marketState';
import { EST } from './config';

export const fetchSharesOutstanding = async (symbol) => {
  const cacheKey = `shares_${symbol}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    const { data, timestamp } = JSON.parse(cached);
    if (Date.now() - timestamp < 24 * 60 * 60 * 1000) {
      return data;
    }
  }

  try {
    const [floatRes, finnhubRes] = await Promise.all([
      fetch(`${WORKER_URL}/fmp/shares-float/${symbol}`),
      fetch(`${WORKER_URL}/finnhub/metric/${symbol}`)
    ]);

    const floatData = await floatRes.json();
    const finnhubData = await finnhubRes.json();

    if (!floatData?.[0]?.outstandingShares) return null;

    const result = {
      sharesOutstanding: floatData[0].outstandingShares,
      forwardPE: finnhubData?.metric?.forwardPE || null
    };

    localStorage.setItem(cacheKey, JSON.stringify({ data: result, timestamp: Date.now() }));

    return result;
  } catch (e) {
    console.error('Fetch error:', e);
    return null;
  }
};

export const fetchYahooQuote = async (symbol) => {
  const response = await fetch(`${WORKER_URL}/yahoo/${symbol}?range=1d&interval=5m&includePrePost=true`);
  const data = await response.json();

  if (!data?.chart?.result?.[0]) return null;

  const result = data.chart.result[0];
  const meta = result.meta;
  const quote = result.indicators.quote[0];
  const timestamps = result.timestamp || [];
  const closes = quote.close || [];

  const dayHigh = meta.regularMarketDayHigh || quote.high?.[0] || meta.regularMarketPrice;
  const dayLow = meta.regularMarketDayLow || quote.low?.[0] || meta.regularMarketPrice;
  const dayOpen = meta.regularMarketOpen || quote.open?.[0] || meta.previousClose;

  let preMarketPrice = null;
  let postMarketPrice = null;

  if (timestamps.length > 0 && closes.length > 0) {
    const lastTimestamp = timestamps[timestamps.length - 1];
    const lastClose = closes[closes.length - 1];

    const lastTime = dayjs.unix(lastTimestamp).tz(EST);
    const hour = lastTime.hour();
    const minute = lastTime.minute();
    const timeInMinutes = hour * 60 + minute;

    const PRE_MARKET_START = 4 * 60;
    const MARKET_OPEN = 9 * 60 + 30;
    const MARKET_CLOSE = 16 * 60;
    const POST_MARKET_END = 20 * 60;

    if (timeInMinutes >= PRE_MARKET_START && timeInMinutes < MARKET_OPEN) {
      preMarketPrice = lastClose;
    } else if (timeInMinutes >= MARKET_CLOSE && timeInMinutes < POST_MARKET_END) {
      postMarketPrice = lastClose;
    }
  }

  return {
    regularMarketPrice: meta.regularMarketPrice,
    previousClose: meta.previousClose,
    open: dayOpen,
    high: dayHigh,
    low: dayLow,
    volume: meta.regularMarketVolume || quote.volume?.[0] || 0,
    shortName: meta.shortName || meta.symbol,
    preMarketPrice,
    postMarketPrice,
    tradingDay: timestamps.length > 0
      ? dayjs.unix(timestamps[timestamps.length - 1]).tz(EST).format('YYYY-MM-DD')
      : null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow
  };
};

export const fetchMarketOpenData = async (symbol) => {
  const [yahooData, finnhubData] = await Promise.all([
    fetchYahooQuote(symbol),
    fetchSharesOutstanding(symbol)
  ]);
  if (!yahooData) return null;

  return {
    currentPrice: yahooData.regularMarketPrice,
    open: yahooData.open,
    high: yahooData.high,
    low: yahooData.low,
    previousClose: yahooData.previousClose,
    volume: yahooData.volume,
    shortName: yahooData.shortName,
    tradingDay: yahooData.tradingDay,
    extendedHoursPrice: null,
    extendedHoursType: null,
    fiftyTwoWeekHigh: yahooData.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: yahooData.fiftyTwoWeekLow,
    sharesOutstanding: finnhubData?.sharesOutstanding,
    forwardPE: finnhubData?.forwardPE
  };
};

export const fetchMarketClosedData = async (symbol, marketState) => {
  const [yahooData, finnhubData] = await Promise.all([
    fetchYahooQuote(symbol),
    fetchSharesOutstanding(symbol)
  ]);
  if (!yahooData) return null;

  let extendedHoursPrice = null;
  let extendedHoursType = null;

  if (marketState.state === MarketState.PRE_MARKET && yahooData.preMarketPrice) {
    extendedHoursPrice = yahooData.preMarketPrice;
    extendedHoursType = 'pre';
  } else if (marketState.state === MarketState.POST_MARKET || marketState.state === MarketState.CLOSED) {
    if (yahooData.postMarketPrice) {
      extendedHoursPrice = yahooData.postMarketPrice;
      extendedHoursType = 'post';
    }
  }

  return {
    currentPrice: yahooData.regularMarketPrice,
    open: yahooData.open,
    high: yahooData.high,
    low: yahooData.low,
    previousClose: yahooData.previousClose,
    volume: yahooData.volume,
    shortName: yahooData.shortName,
    tradingDay: yahooData.tradingDay,
    extendedHoursPrice,
    extendedHoursType,
    fiftyTwoWeekHigh: yahooData.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: yahooData.fiftyTwoWeekLow,
    sharesOutstanding: finnhubData?.sharesOutstanding,
    forwardPE: finnhubData?.forwardPE
  };
};

export const fetchPriceData = async (symbol) => {
  const marketState = getMarketState();

  try {
    if (marketState.isRegularHours) {
      return {
        data: await fetchMarketOpenData(symbol),
        marketState
      };
    } else {
      return {
        data: await fetchMarketClosedData(symbol, marketState),
        marketState
      };
    }
  } catch (error) {
    console.error('Price fetch error:', error);
    return { data: null, marketState };
  }
};
