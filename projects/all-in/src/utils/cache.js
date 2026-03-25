import { CACHE_DURATION } from './config';

export const getCachedData = (symbol) => {
  const key = `stock_${symbol}`;
  const cached = localStorage.getItem(key);
  if (cached) {
    try {
      const { data, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < CACHE_DURATION) return data;
    } catch (e) {
      console.warn('Clearing corrupted cache for', symbol);
      localStorage.removeItem(key);
    }
  }
  return null;
};

export const setCachedData = (symbol, data) => {
  try {
    localStorage.setItem(`stock_${symbol}`, JSON.stringify({ data, timestamp: Date.now() }));
  } catch (e) {
    console.warn('Cache write failed (storage full?):', symbol);
  }
};

// Clear all caches for a symbol (historical data + shares outstanding)
export const clearCaches = (symbol) => {
  localStorage.removeItem(`stock_${symbol}`);
  localStorage.removeItem(`shares_${symbol}`);
};
