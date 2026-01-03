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
  localStorage.setItem(`stock_${symbol}`, JSON.stringify({ data, timestamp: Date.now() }));
};
