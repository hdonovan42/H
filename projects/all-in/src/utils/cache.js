import { CACHE_DURATION } from './config';

export const getCachedData = (symbol) => {
  const cached = localStorage.getItem(`stock_${symbol}`);
  if (cached) {
    const { data, timestamp } = JSON.parse(cached);
    if (Date.now() - timestamp < CACHE_DURATION) return data;
  }
  return null;
};

export const setCachedData = (symbol, data) => {
  localStorage.setItem(`stock_${symbol}`, JSON.stringify({ data, timestamp: Date.now() }));
};
