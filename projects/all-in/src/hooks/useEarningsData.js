import { useState, useEffect, useRef, useCallback } from 'react';
import { WORKER_URL } from '../utils/config';
import { DEFAULT_EARNINGS_STATE, POLL_INTERVALS } from '../types/earnings';

/**
 * Custom hook for fetching earnings data with racing logic
 *
 * @param {string} ticker - Stock symbol (e.g., "TSLA")
 * @param {Object} options
 * @param {boolean} options.isEarningsNight - Whether it's currently earnings night
 * @param {boolean} options.enabled - Whether to fetch data
 * @returns {Object} Earnings state and controls
 */
export function useEarningsData(ticker, options = {}) {
  const { isEarningsNight = false, enabled = true } = options;

  const [state, setState] = useState({
    ...DEFAULT_EARNINGS_STATE,
    isEarningsNight
  });

  const abortControllerRef = useRef(null);
  const pollTimeoutRef = useRef(null);
  const lastFetchRef = useRef(0);

  // Determine current poll interval based on conditions
  const getPollInterval = useCallback(() => {
    if (typeof document !== 'undefined' && document.hidden) {
      return isEarningsNight
        ? POLL_INTERVALS.EARNINGS_NIGHT_HIDDEN
        : POLL_INTERVALS.BACKGROUND;
    }
    if (isEarningsNight) return POLL_INTERVALS.EARNINGS_NIGHT;
    return POLL_INTERVALS.NORMAL;
  }, [isEarningsNight]);

  // Fetch earnings data from unified endpoint
  const fetchEarnings = useCallback(async (mode = 'race') => {
    if (!ticker || !enabled) return;

    // Debounce: don't fetch if we just fetched
    const now = Date.now();
    if (now - lastFetchRef.current < 2000) return;
    lastFetchRef.current = now;

    // Cancel any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const url = `${WORKER_URL}/earnings/unified/${ticker}?mode=${mode}`;
      const response = await fetch(url, {
        signal: abortControllerRef.current.signal,
        cache: 'no-store'
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();

      if (result.error) {
        throw new Error(result.error);
      }

      // Transform response to QuarterEarnings format
      const data = result.data;
      const current = {
        ticker,
        fiscalYear: data?.fiscalYear,
        fiscalQuarter: data?.fiscalQuarter,
        quarter: data?.quarter,
        eps: data?.eps || { estimate: null, actual: null, surprise: null, surprisePercent: null },
        revenue: data?.revenue || { estimate: null, actual: null, surprise: null, surprisePercent: null },
        sources: data?.sources || { eps: { estimate: [], actual: [] }, revenue: { estimate: [], actual: [] } },
        confidence: result.confidence || 'single',
        discrepancies: result.discrepancies || [],
        lastUpdated: new Date().toISOString()
      };

      setState(prev => ({
        ...prev,
        current,
        isLoading: false,
        isEarningsNight,
        pollInterval: getPollInterval(),
        error: null
      }));

      // A live race returns a single unvalidated source — follow up with a merge
      // so the cross-validated record replaces it. Usually a cheap hit: the worker
      // background-merges the race losers into KV and serves that when fresh
      // (result.mode === 'kv'), which needs no follow-up.
      if (mode === 'race' && result.mode === 'race') {
        setTimeout(() => fetchEarnings('merge'), 3000);
      }

    } catch (error) {
      if (error.name === 'AbortError') return;

      console.error('Earnings fetch error:', error);
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error.message
      }));
    }
  }, [ticker, enabled, isEarningsNight, getPollInterval]);

  // Fetch available quarters from KV storage
  const fetchAvailableQuarters = useCallback(async () => {
    if (!ticker) return;

    try {
      const response = await fetch(`${WORKER_URL}/earnings/stored/${ticker}`);
      if (response.ok) {
        const data = await response.json();
        setState(prev => ({
          ...prev,
          availableQuarters: data.availableQuarters || []
        }));

        // If we don't have current data but have stored data, use it
        if (data.latest && !state.current) {
          setState(prev => ({
            ...prev,
            current: data.latest,
            isLoading: false
          }));
        }
      }
    } catch (error) {
      console.error('Available quarters fetch error:', error);
    }
  }, [ticker, state.current]);

  // Select a specific historical quarter
  const selectQuarter = useCallback(async (quarter) => {
    if (!ticker || !quarter) return;

    setState(prev => ({ ...prev, isLoading: true }));

    try {
      const response = await fetch(`${WORKER_URL}/earnings/stored/${ticker}/${quarter}`);
      if (response.ok) {
        const data = await response.json();
        setState(prev => ({
          ...prev,
          current: data,
          isLoading: false
        }));
      } else {
        throw new Error('Quarter not found');
      }
    } catch (error) {
      console.error('Quarter fetch error:', error);
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error.message
      }));
    }
  }, [ticker]);

  // Force refresh current data
  const refresh = useCallback(() => {
    lastFetchRef.current = 0; // Reset debounce
    return fetchEarnings(isEarningsNight ? 'race' : 'merge');
  }, [fetchEarnings, isEarningsNight]);

  // Initial fetch on mount
  useEffect(() => {
    if (enabled && ticker) {
      fetchEarnings(isEarningsNight ? 'race' : 'merge');
      fetchAvailableQuarters();
    }

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [enabled, ticker]); // Don't include fetchEarnings to avoid loop

  // Update when isEarningsNight changes
  useEffect(() => {
    setState(prev => ({ ...prev, isEarningsNight }));
  }, [isEarningsNight]);

  // Polling effect
  useEffect(() => {
    if (!enabled || !ticker) return;

    const scheduleNextPoll = () => {
      const interval = getPollInterval();
      pollTimeoutRef.current = setTimeout(() => {
        fetchEarnings(isEarningsNight ? 'race' : 'merge');
        scheduleNextPoll();
      }, interval);
    };

    scheduleNextPoll();

    return () => {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
      }
    };
  }, [enabled, ticker, isEarningsNight, getPollInterval]); // Don't include fetchEarnings

  // Visibility change handler - fetch when tab becomes visible
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (!document.hidden && enabled && ticker) {
        // Tab became visible, refresh data
        refresh();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, ticker, refresh]);

  return {
    ...state,
    refresh,
    selectQuarter
  };
}

export default useEarningsData;
