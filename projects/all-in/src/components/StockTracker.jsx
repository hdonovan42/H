import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import StockChart from './StockChart';
import { WORKER_URL, EST, SETTLE_POLL_INTERVAL_MS, SETTLE_STABLE_K, SETTLE_TIMEOUT_MS, SETTLE_COLD_WINDOW_MIN } from '../utils/config';
import { dayjs, getMarketState, getTodayEST, hasTradedToday, getSessionDate, MarketState } from '../utils/marketState';
import { getCachedData, setCachedData, clearCaches } from '../utils/cache';
import { fetchPriceData, fetchMarketClock, fetchEarningsDate, parseYahooBars } from '../utils/api';
import { PHASE, determineInitialPhase, isStable, resolvePrice } from '../utils/pricePhase';
import '../styles/stock-tracker.css';

export default function StockTracker() {
  // ?symbol=GOOGL deep-links the tracker to a stock (used by the compare page)
  const [ticker, setTicker] = useState(() => {
    const sym = (new URLSearchParams(window.location.search).get('symbol') || '').toUpperCase();
    return /^[A-Z.^-]{1,8}$/.test(sym) ? sym : 'TSLA';
  });
  const [inputTicker, setInputTicker] = useState('');
  const [data, setData] = useState([]);
  const [chartData, setChartData] = useState([]);
  const [maxRangeData, setMaxRangeData] = useState([]);
  const [intradayData, setIntradayData] = useState([]);
  const [weeklyData, setWeeklyData] = useState([]);
  const [monthlyData, setMonthlyData] = useState([]);
  const [timeframe, setTimeframe] = useState(() => {
    const initialState = getMarketState();
    return initialState.isRegularHours ? '1D' : '6M';
  });
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [priceFlash, setPriceFlash] = useState(null);
  const [sortConfig, setSortConfig] = useState({ key: 'date', direction: 'desc' });
  const [sharesCount, setSharesCount] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [earnings, setEarnings] = useState(null);
  const [currentMarketState, setCurrentMarketState] = useState(getMarketState());
  // EST date | market state — changes on every session transition (see the monitor below)
  const [sessionKey, setSessionKey] = useState(() => `${getTodayEST()}|${getMarketState().state}`);
  const [clockData, setClockData] = useState(null);

  // Close-settle state machine: live → settling → settled (see utils/pricePhase.js).
  // The single source of truth all views read from, so box/spreadsheet/light agree.
  const [phase, setPhase] = useState(() => determineInitialPhase({ marketState: getMarketState(), coldWindowMin: SETTLE_COLD_WINDOW_MIN }));
  const [settlingValue, setSettlingValue] = useState(null);
  const [settledValue, setSettledValue] = useState(null);

  const lastPriceRef = useRef(null);
  const wsRef = useRef(null);
  const isConnectingRef = useRef(false);
  const clockDataRef = useRef(null);
  const fetchAbortRef = useRef(null);
  const settleIntervalRef = useRef(null);   // close-settle poll interval id
  const settleStartRef = useRef(0);          // ms timestamp settling began (timeout backstop)
  const settleReadingsRef = useRef([]);      // recent cent-rounded reads for stability test
  const openSeenRef = useRef(null);          // EST date on which Alpaca last reported the market open
  const sessionCloseRef = useRef(null);      // unix s of that session's close (half-days included)
  const prevIsOpenRef = useRef(null);        // previous Alpaca isOpen, for close-edge detection
  const tickerRef = useRef(ticker);          // current ticker, so in-flight settle polls can bail
  const [wsAvailable, setWsAvailable] = useState(true);
  const [currency, setCurrency] = useState('USD');
  const [exchangeRate, setExchangeRate] = useState(null);

  // Infinite scroll state
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [fullHistoryLoaded, setFullHistoryLoaded] = useState(false);
  const sentinelRef = useRef(null);

  // Fetch market clock on mount, every 30 sec, and schedule exact transition fetches
  useEffect(() => {
    let openTimeout = null;
    let closeTimeout = null;

    const scheduleTransitionFetch = (clock) => {
      // Clear any existing scheduled fetches
      if (openTimeout) clearTimeout(openTimeout);
      if (closeTimeout) clearTimeout(closeTimeout);

      const now = dayjs();
      const maxScheduleAhead = 12 * 60 * 60 * 1000; // Only schedule within 12 hours

      // Schedule fetch 1 second after market open
      if (clock.nextOpen) {
        const msUntilOpen = dayjs(clock.nextOpen).diff(now);
        if (msUntilOpen > 0 && msUntilOpen < maxScheduleAhead) {
          openTimeout = setTimeout(() => loadClock(), msUntilOpen + 1000);
        }
      }

      // Schedule fetch 1 second after market close
      if (clock.nextClose) {
        const msUntilClose = dayjs(clock.nextClose).diff(now);
        if (msUntilClose > 0 && msUntilClose < maxScheduleAhead) {
          closeTimeout = setTimeout(() => loadClock(), msUntilClose + 1000);
        }
      }
    };

    const loadClock = async () => {
      const clock = await fetchMarketClock();
      if (clock) {
        clockDataRef.current = clock;
        if (clock.isOpen) {
          openSeenRef.current = getTodayEST();
          sessionCloseRef.current = clock.nextClose?.unix() ?? null;
        }
        setClockData(clock);
        scheduleTransitionFetch(clock);
      }
    };

    loadClock();
    const clockInterval = setInterval(loadClock, 30 * 1000); // Refresh every 30 sec

    return () => {
      clearInterval(clockInterval);
      if (openTimeout) clearTimeout(openTimeout);
      if (closeTimeout) clearTimeout(closeTimeout);
    };
  }, []);

  // Market state + session key, re-derived every second. The key (EST date | state)
  // changes on every transition — pre→open, open→post, post→closed, midnight, or a
  // laptop waking hours later — and drives the single data-loading effect below.
  useEffect(() => {
    const tick = () => {
      const tradedToday = hasTradedToday({ clockData, bars: data, openSeenDate: openSeenRef.current });
      const newState = getMarketState(clockData, { tradedToday });
      setCurrentMarketState(prev => (prev.state !== newState.state ? newState : prev));
      setSessionKey(`${getTodayEST()}|${newState.state}`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [clockData, data]);

  // Quote + daily bars. The quote supplies only what is not session-shaped: the live
  // price, extended-hours price, 52-week range and fundamentals. Yahoo's meta describes
  // whichever session *Yahoo* considers current — all pre-market, that is yesterday's —
  // so previous close, open, day range and volume are derived from bars instead (see
  // the session model below) and never snapshotted here.
  const fetchStockData = async (symbol) => {
    const signal = fetchAbortRef.current?.signal;
    const marketState = getMarketState(clockDataRef.current);

    try {
      const { data: priceData } = await fetchPriceData(symbol, clockDataRef.current);
      if (signal?.aborted) return;

      if (priceData) {
        setCompanyName(priceData.shortName || symbol);
        setQuote({
          c: priceData.currentPrice,
          extendedHoursPrice: priceData.extendedHoursPrice,
          extendedHoursType: priceData.extendedHoursType,
          fiftyTwoWeekHigh: priceData.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: priceData.fiftyTwoWeekLow,
          sharesOutstanding: priceData.sharesOutstanding,
          forwardPE: priceData.forwardPE
        });

        if (marketState.usingApi) {
          console.log(`Market: ${marketState.state.toUpperCase()} | ${symbol}: $${priceData.currentPrice.toFixed(2)}${priceData.extendedHoursPrice ? ` | Extended: $${priceData.extendedHoursPrice.toFixed(2)}` : ''}`);
        }
      }

      let historicalData = getCachedData(symbol);
      if (!historicalData) {
        const barsRes = await fetch(`${WORKER_URL}/yahoo/${symbol}?range=6mo&interval=1d`, { signal });
        const result = (await barsRes.json())?.chart?.result?.[0];
        if (result) {
          historicalData = parseYahooBars(result).sort((a, b) => (a.date < b.date ? -1 : 1));
          if (historicalData.length) setCachedData(symbol, historicalData);
        }
      }

      if (historicalData?.length > 0) setData(prev => prev.length > historicalData.length ? mergeData(prev, historicalData) : historicalData);
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.error('Error:', error);
    }
    setLoading(false);
  };

  // Merge and dedupe historical data, sorted oldest-first
  // Incoming data takes priority for matching dates (picks up Yahoo corrections)
  const mergeData = (existing, incoming) => {
    const incomingMap = new Map(incoming.map(d => [d.date, d]));
    const merged = existing.map(d => incomingMap.get(d.date) || d);
    const existingDates = new Set(existing.map(d => d.date));
    const newRows = incoming.filter(d => !existingDates.has(d.date));
    return [...merged, ...newRows].sort((a, b) => dayjs(a.date).unix() - dayjs(b.date).unix());
  };

  // Fetch next 6-month chunk of older history
  const fetchMoreHistory = useCallback(async () => {
    if (isFetchingMore || !hasMoreHistory || data.length === 0) return;

    const fiveYearsAgo = dayjs().subtract(5, 'year').unix();
    const oldestDate = dayjs(data[0].date);
    const period2 = oldestDate.subtract(1, 'day').unix();
    if (period2 < fiveYearsAgo) {
      setHasMoreHistory(false);
      return;
    }
    const period1 = Math.max(oldestDate.subtract(6, 'month').unix(), fiveYearsAgo);

    setIsFetchingMore(true);
    try {
      const res = await fetch(`${WORKER_URL}/yahoo/${ticker}?interval=1d&period1=${period1}&period2=${period2}`);
      const json = await res.json();
      if (json?.chart?.result?.[0]) {
        const rows = parseYahooBars(json.chart.result[0]);
        if (rows.length === 0) {
          setHasMoreHistory(false);
        } else {
          const merged = mergeData(data, rows);
          setData(merged);
          if (dayjs(merged[0].date).unix() <= fiveYearsAgo + 7 * 86400) {
            setHasMoreHistory(false);
          }
        }
      } else {
        setHasMoreHistory(false);
      }
    } catch (err) {
      console.error('Failed to fetch more history:', err);
    } finally {
      setIsFetchingMore(false);
    }
  }, [isFetchingMore, hasMoreHistory, data, ticker]);

  // Yahoo bars → [{ date: ISO, day: EST 'YYYY-MM-DD', open, high, low, close, volume }].
  // `day` lets views pick out one session without re-parsing dates on every render.
  const fetchBars = async (symbol, query) => {
    const res = await fetch(`${WORKER_URL}/yahoo/${symbol}?${query}`, { signal: fetchAbortRef.current?.signal });
    const result = (await res.json())?.chart?.result?.[0];
    const q = result?.indicators?.quote?.[0];
    if (!result?.timestamp || !q) return null;
    return result.timestamp.map((t, i) => {
      const et = dayjs.unix(t).tz(EST);
      return { date: et.toISOString(), day: et.format('YYYY-MM-DD'), open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 };
    }).filter(b => b.close !== null);
  };

  const barLoader = (query, setBars) => async (symbol) => {
    try {
      const bars = await fetchBars(symbol, query);
      if (bars) setBars(bars);
    } catch (error) {
      if (error.name !== 'AbortError') console.error(`Error fetching bars (${query}):`, error);
    }
  };

  // Chart datasets: 1D (1-min, regular hours only), 1W (15-min), 1M (hourly), 6M–5Y (daily), ALL (monthly)
  const fetchIntradayData = barLoader('range=1d&interval=1m', setIntradayData);
  const fetchWeeklyData = barLoader('range=5d&interval=15m', setWeeklyData);
  const fetchMonthlyData = barLoader('range=60d&interval=1h', setMonthlyData);
  const fetchChartData = barLoader('range=5y&interval=1d', setChartData);
  const fetchMaxRangeData = barLoader('range=max&interval=1mo', setMaxRangeData);

  // ── Close-settle machine ───────────────────────────────────────────────
  // Stop any running settle poll and clear its reading buffer.
  const stopSettlePoll = useCallback(() => {
    if (settleIntervalRef.current) {
      clearInterval(settleIntervalRef.current);
      settleIntervalRef.current = null;
    }
    settleReadingsRef.current = [];
  }, []);

  // Poll the official close (cache-bypassed) until Yahoo reports it, then lock every
  // view to it. Bails if the ticker changes mid-flight; backstop-locks on timeout.
  const startSettlePoll = useCallback((activeTicker) => {
    stopSettlePoll();
    // Today's close as Alpaca reported it while open; a cold load inside the settle
    // window never saw the session, so assume the regular 16:00.
    const witnessed = sessionCloseRef.current;
    const closeAt = witnessed && openSeenRef.current === getTodayEST()
      ? witnessed
      : dayjs.tz(`${getTodayEST()} 16:00`, EST).unix();
    settleStartRef.current = Date.now();
    settleReadingsRef.current = [];
    setSettlingValue(null);
    setPhase(PHASE.SETTLING);
    console.log(`[settle] ${activeTicker} market closed — settling official close…`);

    const pollOnce = async () => {
      if (tickerRef.current !== activeTicker) { stopSettlePoll(); return; }
      try {
        const { data: pd } = await fetchPriceData(activeTicker, clockDataRef.current, { noCache: true });
        if (tickerRef.current !== activeTicker) return;
        const v = pd?.currentPrice;
        if (v == null) return;

        setSettlingValue(v);
        const reads = [...settleReadingsRef.current, v];
        settleReadingsRef.current = reads;

        // Official = Yahoo's last regular print is stamped at/after the close. A quiet run
        // of the last continuous-trading print is NOT the close: locking on stability
        // alone froze a preliminary price all evening while a fresh load showed the real one.
        const official = pd.regularMarketTime >= closeAt;
        if (official && isStable(reads, SETTLE_STABLE_K)) {
          console.log(`[settle] ${activeTicker} official close locked at $${v.toFixed(2)} (${reads.length} reads)`);
          setSettledValue(v);
          setPhase(PHASE.SETTLED);
          stopSettlePoll();
        } else if (Date.now() - settleStartRef.current > SETTLE_TIMEOUT_MS) {
          console.warn(`[settle] ${activeTicker} close did not stabilise in time; locking last value $${v.toFixed(2)}`);
          setSettledValue(v);
          setPhase(PHASE.SETTLED);
          stopSettlePoll();
        }
      } catch (error) {
        console.error('Settle poll error:', error);
      }
    };

    pollOnce();
    settleIntervalRef.current = setInterval(pollOnce, SETTLE_POLL_INTERVAL_MS);
  }, [stopSettlePoll]);

  // Initial load and ticker changes
  useEffect(() => {
    document.title = ticker;
    tickerRef.current = ticker;
    if (fetchAbortRef.current) fetchAbortRef.current.abort();
    fetchAbortRef.current = new AbortController();
    lastPriceRef.current = null;
    setHasMoreHistory(true);
    setIsFetchingMore(false);
    setFullHistoryLoaded(false);
    setData([]);
    setChartData([]);
    setMaxRangeData([]);
    setIntradayData([]);
    setWeeklyData([]);
    setMonthlyData([]);
    setQuote(null);

    // Reset the close-settle machine for the new ticker, then re-derive its phase.
    stopSettlePoll();
    setSettlingValue(null);
    setSettledValue(null);
    prevIsOpenRef.current = clockDataRef.current ? clockDataRef.current.isOpen : null;
    const initialPhase = determineInitialPhase({
      marketState: getMarketState(clockDataRef.current),
      coldWindowMin: SETTLE_COLD_WINDOW_MIN
    });
    setPhase(initialPhase);

    setLoading(true);

    // Cold load within the post-close window: start settling straight away.
    if (initialPhase === PHASE.SETTLING) startSettlePoll(ticker);
  }, [ticker]);

  // The ONE data-loading path: on ticker change and on every session transition
  // (sessionKey = EST date | market state, so pre→open, open→post, post→closed,
  // midnight, and a laptop waking hours later all count). It reloads every dataset;
  // what the page shows is derived from the data, so nothing transition-specific is
  // left to keep in sync.
  useEffect(() => {
    clearCaches(ticker);
    fetchStockData(ticker);
    fetchIntradayData(ticker);
    fetchWeeklyData(ticker);
    fetchMonthlyData(ticker);
    fetchChartData(ticker);
    fetchMaxRangeData(ticker);

    // A settle lock belongs to its own evening: past post-market, show the freshly
    // loaded quote exactly as a cold load would.
    if (phase === PHASE.SETTLED && currentMarketState.state !== MarketState.POST_MARKET) {
      setSettledValue(null);
      setPhase(PHASE.INERT);
    }
  }, [ticker, sessionKey]);

  // The genuine close, via Alpaca's isOpen edge (works for regular and half-days; never
  // false-fires on holidays, where isOpen is never true): settle to the official close.
  // The edge only means "the close just happened" if the session was today and we are
  // inside the settle window — a laptop waking after the bell lands where a cold load
  // would. The data reload itself comes from the session transition above.
  useEffect(() => {
    if (!clockData) return;
    const prevIsOpen = prevIsOpenRef.current;
    prevIsOpenRef.current = clockData.isOpen;
    if (prevIsOpen !== true || clockData.isOpen !== false) return;

    const closedToday = openSeenRef.current === getTodayEST();
    const minsSinceClose = (dayjs().unix() - (sessionCloseRef.current ?? 0)) / 60;
    if (closedToday && minsSinceClose <= SETTLE_COLD_WINDOW_MIN) startSettlePoll(ticker);
    else setPhase(closedToday ? PHASE.SETTLED : PHASE.INERT);
  }, [clockData, ticker]);

  // Back to a live regular session — release any settle lock immediately.
  useEffect(() => {
    if (currentMarketState.isRegularHours && phase !== PHASE.LIVE) {
      stopSettlePoll();
      setSettlingValue(null);
      setSettledValue(null);
      setPhase(PHASE.LIVE);
    }
  }, [currentMarketState.isRegularHours]);

  // Stop the settle poll on unmount.
  useEffect(() => () => stopSettlePoll(), [stopSettlePoll]);

  // Next earnings date is per-symbol; clear before fetching so a slow
  // response never shows the previous ticker's date.
  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setEarnings(null);
    fetchEarningsDate(ticker).then(result => {
      if (!cancelled) setEarnings(result);
    });
    return () => { cancelled = true; };
  }, [ticker]);

  // WebSocket connection
  useEffect(() => {
    let ws = null;
    let reconnectTimeout = null;
    let reconnectAttempts = 0;
    let currentSubscribedSymbol = null;
    let isMounted = true;
    let abortController = null;
    let lastMessageTime = Date.now();
    let healthCheckInterval = null;

    const MAX_RECONNECT_ATTEMPTS = 3;  // Cap at ~1 min before falling back to polling
    const STALE_CONNECTION_MS = 60000;

    const getReconnectDelay = () => Math.min(500 * Math.pow(2, reconnectAttempts), 30000);

    const cleanup = (skipWsClose = false) => {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      if (!skipWsClose && ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
        ws = null;
      }
    };

    const connectWebSocket = async () => {
      if (!isMounted) return;

      const marketState = getMarketState(clockDataRef.current);
      if (!marketState.isRegularHours) return;

      if (isConnectingRef.current) return;

      cleanup();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }

      isConnectingRef.current = true;
      abortController = new AbortController();
      const fetchTimeout = setTimeout(() => abortController.abort(), 8000);

      try {
        const res = await fetch(`${WORKER_URL}/finnhub/ws-url`, { signal: abortController.signal });
        clearTimeout(fetchTimeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { url: wsUrl } = await res.json();

        if (!isMounted) {
          isConnectingRef.current = false;
          return;
        }

        ws = new WebSocket(wsUrl);

        const connectionTimeout = setTimeout(() => {
          if (ws && ws.readyState !== WebSocket.OPEN) {
            ws.close();
          }
        }, 10000);

        ws.onopen = () => {
          clearTimeout(connectionTimeout);
          if (!isMounted) {
            ws.close();
            return;
          }

          console.log('WebSocket connected');
          isConnectingRef.current = false;
          reconnectAttempts = 0;
          wsRef.current = ws;
          lastMessageTime = Date.now();
          setWsAvailable(true);

          if (ticker) {
            ws.send(JSON.stringify({ type: 'subscribe', symbol: ticker }));
            currentSubscribedSymbol = ticker;
          }
        };

        ws.onmessage = (event) => {
          lastMessageTime = Date.now();
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'trade' && msg.data?.length > 0) {
              const lastTrade = msg.data[msg.data.length - 1];
              if (lastTrade?.s && lastTrade.s !== ticker) return;
              const newPrice = lastTrade?.p;
              if (newPrice == null) return;
              if (lastPriceRef.current === newPrice) return;
              const oldPrice = lastPriceRef.current;
              const direction = oldPrice === null || newPrice >= oldPrice ? 'up' : 'down';
              lastPriceRef.current = newPrice;

              setQuote(prev => (prev ? { ...prev, c: newPrice } : prev));
              setPriceFlash(null);
              requestAnimationFrame(() => setPriceFlash(direction));
            }
          } catch (e) {
            console.warn('WebSocket message parse error:', e.message);
          }
        };

        ws.onerror = () => {
          clearTimeout(connectionTimeout);
          isConnectingRef.current = false;
          setWsAvailable(false);
        };

        ws.onclose = () => {
          clearTimeout(connectionTimeout);
          isConnectingRef.current = false;
          wsRef.current = null;
          currentSubscribedSymbol = null;
          setWsAvailable(false);

          if (isMounted && getMarketState(clockDataRef.current).isRegularHours) {
            scheduleReconnect();
          }
        };

      } catch (e) {
        clearTimeout(fetchTimeout);
        isConnectingRef.current = false;
        setWsAvailable(false);
        if (e.name === 'AbortError') {
          console.log('WebSocket URL fetch aborted (timeout)');
          if (isMounted) scheduleReconnect();
          return;
        }
        console.log('WebSocket connection failed');
        if (isMounted) scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }

      if (!isMounted || !getMarketState(clockDataRef.current).isRegularHours) return;

      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts = 0;
        reconnectTimeout = setTimeout(connectWebSocket, 60000);
        return;
      }

      const delay = getReconnectDelay();
      reconnectAttempts++;
      reconnectTimeout = setTimeout(connectWebSocket, delay);
    };

    if (getMarketState(clockDataRef.current).isRegularHours) {
      connectWebSocket();
    }

    healthCheckInterval = setInterval(() => {
      if (!isMounted) return;

      const marketState = getMarketState(clockDataRef.current);
      const hasConnection = wsRef.current?.readyState === WebSocket.OPEN;

      if (marketState.isRegularHours && !hasConnection && !isConnectingRef.current) {
        reconnectAttempts = 0;
        connectWebSocket();
      }
      else if (!marketState.isRegularHours && hasConnection) {
        if (wsRef.current) {
          wsRef.current.onclose = null;
          wsRef.current.close();
        }
        wsRef.current = null;
        currentSubscribedSymbol = null;
      }
      else if (marketState.isRegularHours && hasConnection && Date.now() - lastMessageTime > STALE_CONNECTION_MS) {
        if (wsRef.current) {
          wsRef.current.close();
        }
      }
    }, 15000);

    return () => {
      isMounted = false;
      cleanup();
      clearInterval(healthCheckInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (wsRef.current) {
        if (currentSubscribedSymbol && wsRef.current.readyState === WebSocket.OPEN) {
          try { wsRef.current.send(JSON.stringify({ type: 'unsubscribe', symbol: currentSubscribedSymbol })); } catch (e) {}
        }
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      isConnectingRef.current = false;
    };
  }, [ticker]);

  // Keep the session's bars fresh while it trades (and while the close settles, so the
  // final minute lands). Transitions themselves are covered by the session reload.
  const sessionLive = currentMarketState.isRegularHours || phase === PHASE.SETTLING;
  useEffect(() => {
    if (!ticker || !sessionLive) return;
    const interval = setInterval(() => {
      fetchIntradayData(ticker);
      fetchWeeklyData(ticker);
      fetchMonthlyData(ticker);
    }, 60000);
    return () => clearInterval(interval);
  }, [ticker, sessionLive]);

  // Extended hours polling
  useEffect(() => {
    if (!ticker) return;
    if (!currentMarketState.isExtendedHours) return;

    const pollExtendedHours = async () => {
      const currentState = getMarketState(clockDataRef.current);

      if (!currentState.isExtendedHours) {
        console.log('Extended hours ended, stopping poll');
        return;
      }

      try {
        const { data: priceData } = await fetchPriceData(ticker, clockDataRef.current);

        if (priceData && priceData.extendedHoursPrice) {
          setQuote(prev => {
            if (!prev) return prev;
            return {
              ...prev,
              extendedHoursPrice: priceData.extendedHoursPrice,
              extendedHoursType: priceData.extendedHoursType
            };
          });

          console.log(`Market: ${currentState.state.toUpperCase()} | ${ticker}: $${priceData.currentPrice.toFixed(2)} | Extended: $${priceData.extendedHoursPrice.toFixed(2)}`);
        }
      } catch (error) {
        console.error('Extended hours poll error:', error);
      }
    };

    pollExtendedHours();
    const interval = setInterval(pollExtendedHours, 30000);

    return () => {
      console.log('Extended hours polling stopped');
      clearInterval(interval);
    };
  }, [ticker, currentMarketState.state]);

  // WebSocket fallback polling - when WebSocket unavailable during market hours
  useEffect(() => {
    if (!ticker) return;
    if (wsAvailable) return;  // WebSocket working, no need to poll
    if (!currentMarketState.isRegularHours) return;  // Only poll during market hours

    const pollFallback = async () => {
      try {
        const { data: priceData } = await fetchPriceData(ticker, clockDataRef.current);

        if (priceData && priceData.currentPrice) {
          setQuote(prev => (prev ? { ...prev, c: priceData.currentPrice } : prev));
        }
      } catch (error) {
        console.error('Fallback poll error:', error);
      }
    };

    console.log('WebSocket unavailable, starting fallback polling');
    pollFallback();  // Immediate first poll
    const interval = setInterval(pollFallback, 5000);

    return () => {
      console.log('Fallback polling stopped');
      clearInterval(interval);
    };
  }, [ticker, wsAvailable, currentMarketState.isRegularHours]);

  // Fetch exchange rate for currency toggle
  useEffect(() => {
    const fetchExchangeRate = async () => {
      try {
        const res = await fetch(`${WORKER_URL}/exchange-rate`);
        if (res.ok) {
          const data = await res.json();
          setExchangeRate(data.rate);
        }
      } catch (error) {
        console.error('Exchange rate fetch error:', error);
        setExchangeRate(0.79); // Fallback rate
      }
    };

    fetchExchangeRate();
  }, []);

  // Infinite scroll observer
  useEffect(() => {
    if (sortConfig.key !== 'date' || !hasMoreHistory || !sentinelRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) fetchMoreHistory();
      },
      { root: null, rootMargin: '0px 0px 200px 0px', threshold: 0 }
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMoreHistory, sortConfig.key, fetchMoreHistory]);

  // Single resolved price — the one number the box, spreadsheet today-close and
  // chart all read, so they can never contradict each other. Post-close this is the
  // settling/settled official close, never the frozen last live tick.
  const currentPrice = resolvePrice({
    phase,
    quote,
    settlingValue,
    settledValue,
    dataLastClose: data[data.length - 1]?.close
  });

  // ── Session model ──────────────────────────────────────────────────────
  // Everything session-shaped derives from ONE date — the session being shown — plus
  // the bars, recomputed every render. Nothing is captured at load and then has to be
  // "updated" on a transition: the previous close is simply the close of the row before
  // the session's row, so the 1D dotted line, the change figure and the spreadsheet
  // cannot disagree or go stale.
  const tradedToday = hasTradedToday({ clockData, bars: data, openSeenDate: openSeenRef.current });
  const sessionDate = getSessionDate({ bars: data, tradedToday });
  const isSessionToday = sessionDate === getTodayEST();

  // The session's own regular-hours minute bars (the intraday feed excludes pre/post).
  const sessionBars = useMemo(
    () => intradayData.filter(b => b.day === sessionDate),
    [intradayData, sessionDate]
  );

  // Spreadsheet rows: daily bars up to the session (a bar Yahoo dates beyond it is
  // premature), with today's row rebuilt from its minute bars + the resolved live price.
  const processSpreadsheetData = useMemo(() => {
    const byDate = new Map();
    for (const row of data) {
      const date = String(row.date).slice(0, 10);
      if (!sessionDate || date <= sessionDate) byDate.set(date, { ...row, date });
    }

    if (isSessionToday && currentPrice) {
      const bar = byDate.get(sessionDate);
      const bars = sessionBars.length ? sessionBars : (bar ? [bar] : []);
      byDate.set(sessionDate, {
        date: sessionDate,
        open: bars[0]?.open ?? currentPrice,
        high: Math.max(currentPrice, ...bars.map(b => b.high ?? currentPrice)),
        low: Math.min(currentPrice, ...bars.map(b => b.low ?? currentPrice)),
        close: currentPrice,
        // Minute bars miss the auction prints the daily bar carries: take whichever is further along
        volume: Math.max(bar?.volume || 0, sessionBars.reduce((sum, b) => sum + (b.volume || 0), 0)),
      });
    }

    const rows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    return rows.map((row, i) => ({ ...row, chg: i === 0 ? null : row.close - rows[i - 1].close }));
  }, [data, sessionDate, isSessionToday, sessionBars, currentPrice]);

  const sortedData = useMemo(() => {
    return [...processSpreadsheetData].sort((a, b) => {
      if (a[sortConfig.key] < b[sortConfig.key]) return sortConfig.direction === 'asc' ? -1 : 1;
      if (a[sortConfig.key] > b[sortConfig.key]) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [processSpreadsheetData, sortConfig]);

  // Derived values
  const lastTwo = processSpreadsheetData.slice(-2);
  const todayChange = lastTwo.length === 2 ? lastTwo[1].close - lastTwo[0].close : 0;
  const todayChangePercent = lastTwo.length === 2 ? (todayChange / lastTwo[0].close) * 100 : 0;
  const previousClose = lastTwo.length === 2 ? lastTwo[0].close : null; // the 1D dotted line
  const sessionRow = lastTwo[lastTwo.length - 1];
  const dayHigh = sessionRow?.high || 0;
  const dayLow = sessionRow?.low || 0;
  const recentData = data.slice(-65);
  const avgVolume = recentData.length > 0 ? recentData.reduce((sum, d) => sum + d.volume, 0) / recentData.length : 0;
  const week52High = quote?.fiftyTwoWeekHigh || (data.length > 0 ? Math.max(...data.map(d => d.high)) : 0);
  const week52Low = quote?.fiftyTwoWeekLow || (data.length > 0 ? Math.min(...data.map(d => d.low)) : 0);
  const marketCap = quote?.sharesOutstanding ? (quote.sharesOutstanding * currentPrice) / 1e6 : 0;
  const forwardPE = quote?.forwardPE || 0;

  // 6M–5Y charts end on the session's spreadsheet row, so they move with the live price too.
  const chartDataLive = useMemo(() => {
    if (!chartData.length || !sessionDate || sessionRow?.date !== sessionDate) return chartData;
    const bar = { ...sessionRow, date: dayjs.tz(`${sessionDate} 09:30`, EST).toISOString(), day: sessionDate };
    return [...chartData.filter(b => b.day < sessionDate), bar];
  }, [chartData, sessionDate, sessionRow]);

  // Handlers
  const handleTickerSubmit = (e) => {
    e.preventDefault();
    if (inputTicker.trim()) {
      const sym = inputTicker.toUpperCase();
      setTicker(sym);
      setInputTicker('');
      setSharesCount('');
      window.history.replaceState({}, '', window.location.pathname + (sym === 'TSLA' ? '' : `?symbol=${sym}`));
    }
  };

  const handleSort = useCallback(async (key) => {
    setSortConfig(prev => ({ key, direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc' }));
    if (key !== 'date' && !fullHistoryLoaded) {
      const signal = fetchAbortRef.current?.signal;
      setIsFetchingMore(true);
      try {
        const res = await fetch(`${WORKER_URL}/yahoo/${ticker}?range=5y&interval=1d`, { signal });
        const json = await res.json();
        if (json?.chart?.result?.[0]) {
          const rows = parseYahooBars(json.chart.result[0]);
          if (rows.length > 0) setData(prev => mergeData(prev, rows));
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('Failed to fetch full history for sort:', err);
      } finally {
        setIsFetchingMore(false);
        setFullHistoryLoaded(true);
        setHasMoreHistory(false);
      }
    }
  }, [fullHistoryLoaded, ticker]);

  const handleCurrencyToggle = useCallback(() => {
    setCurrency(prev => prev === 'USD' ? 'GBP' : 'USD');
  }, []);

  const currencySymbol = currency === 'USD' ? '$' : '£';
  const convertValue = useCallback((usdValue) => {
    if (usdValue === null || usdValue === undefined) return null;
    return currency === 'GBP' && exchangeRate
      ? Math.round(usdValue * exchangeRate)
      : usdValue;
  }, [currency, exchangeRate]);

  return (
    <div className="page-wrapper">
      {loading && <div className="loading"><div className="loading-text">Loading {ticker}...</div></div>}

      <div className="container">
        <header className="header">
          <div className="ticker-display">{companyName || ticker}</div>
          <div className="header-right">
            <a href="compare.html" className="page-link">compare</a>
            <form className="ticker-form" onSubmit={handleTickerSubmit}>
              <input type="text" className="ticker-input" value={inputTicker} onChange={(e) => setInputTicker(e.target.value)} placeholder="TICKER" maxLength={5} />
            </form>
          </div>
        </header>

        <div className="top-row">
          <div className="price-section box">
            <div className="price-main">
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%'}}>
                <div style={{display: 'flex', flexDirection: 'column'}}>
                  <span
                    className={`price-current ${priceFlash ? `flash-${priceFlash}` : ''}`}
                    onAnimationEnd={() => setPriceFlash(null)}
                  >
                    ${currentPrice.toFixed(2)}
                  </span>
                  <span className={`price-change ${todayChange >= 0 ? 'positive' : 'negative'}`}>
                    {todayChange >= 0 ? '+' : ''}{todayChange.toFixed(2)} ({todayChange >= 0 ? '+' : ''}{todayChangePercent.toFixed(2)}%)
                  </span>
                </div>
                <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px'}}>
                  <div className={`status-dot ${phase === PHASE.SETTLING ? 'settling' : (currentMarketState.isRegularHours ? 'open' : 'closed')}`}></div>
                  {phase === PHASE.SETTLING && <span className="settling-label">settling…</span>}
                </div>
              </div>
            </div>

            {!currentMarketState.isRegularHours && quote?.extendedHoursPrice && (() => {
              const marketChange = quote.extendedHoursPrice - currentPrice;
              const marketChangePercent = (marketChange / currentPrice) * 100;
              const isPositive = marketChange >= 0;

              return (
                <div className="extended-hours-bar">
                  <span style={{ fontSize: '12px', fontWeight: 600 }}>{quote.extendedHoursType === 'pre' ? 'PRE' : 'POST'}</span>
                  <span style={{ fontSize: '18px', fontWeight: 600, marginRight: '16px' }}>${quote.extendedHoursPrice.toFixed(2)}</span>
                  <span className={isPositive ? 'positive' : 'negative'} style={{ fontSize: '13px', fontWeight: 600 }}>
                    {isPositive ? '+' : ''}${marketChange.toFixed(2)} ({isPositive ? '+' : ''}{marketChangePercent.toFixed(2)}%)
                  </span>
                </div>
              );
            })()}

            <hr style={{margin: '16px 0', border: 'none', borderTop: '1px solid #e8e5dc'}} />
            <div className="stats-grid">
              <div className="stat-row"><span className="stat-label">Day Range</span><span className="stat-value">{dayLow.toFixed(2)} - {dayHigh.toFixed(2)}</span></div>
              <div className="stat-row"><span className="stat-label">52 Week Range</span><span className="stat-value">{week52Low.toFixed(2)} - {week52High.toFixed(2)}</span></div>
              <div className="stat-row"><span className="stat-label">Avg. Volume</span><span className="stat-value">{Math.floor(avgVolume).toLocaleString()}</span></div>
              <div className="stat-row"><span className="stat-label">Market Cap</span><span className="stat-value">{marketCap <= 0 ? 'N/A' : marketCap >= 1000000 ? (marketCap/1000000).toPrecision(3)+'T' : marketCap >= 1000 ? (marketCap/1000).toPrecision(3)+'B' : marketCap.toPrecision(3)+'M'}</span></div>
              <div className="stat-row"><span className="stat-label">Forward P/E</span><span className="stat-value">{forwardPE > 0 ? forwardPE.toFixed(2) : 'N/A'}</span></div>
              <div className="stat-row">
                {ticker === 'TSLA' ? <a href="earnings.html" className="stat-label earnings-link">Earnings Date</a> : <span className="stat-label">Earnings Date</span>}
                <span className="stat-value">{earnings?.earningsDate ? `${dayjs(earnings.earningsDate).format('MMM D, YYYY')}${earnings.isEstimate ? ' (est.)' : ''}` : 'N/A'}</span>
              </div>
            </div>
          </div>

          <div className="chart-wrapper">
            <StockChart
              chartData={chartDataLive}
              maxRangeData={maxRangeData}
              intradayData={intradayData}
              weeklyData={weeklyData}
              monthlyData={monthlyData}
              timeframe={timeframe}
              onTimeframeChange={setTimeframe}
              previousClose={previousClose}
              sessionDate={sessionDate}
              livePrice={currentPrice}
              marketOpen={currentMarketState.isRegularHours}
            />
          </div>
        </div>

        <div className="box spreadsheet" style={{marginTop: '10px'}}>
          <div className="spreadsheet-scroll">
            <div className="spreadsheet-inner">
              <div className="spreadsheet-header">
                <div onClick={() => handleSort('date')}>date {sortConfig.key === 'date' && <span className="sort-indicator">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>}</div>
                <div onClick={() => handleSort('open')}>open {sortConfig.key === 'open' && <span className="sort-indicator">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>}</div>
                <div onClick={() => handleSort('high')}>high {sortConfig.key === 'high' && <span className="sort-indicator">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>}</div>
                <div onClick={() => handleSort('low')}>low {sortConfig.key === 'low' && <span className="sort-indicator">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>}</div>
                <div onClick={() => handleSort('close')}>close {sortConfig.key === 'close' && <span className="sort-indicator">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>}</div>
                <div onClick={() => handleSort('volume')}>vol {sortConfig.key === 'volume' && <span className="sort-indicator">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>}</div>
                <div onClick={() => handleSort('chg')}>chg {sortConfig.key === 'chg' && <span className="sort-indicator">{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>}</div>
                <div className="header-input-cell"><input type="text" className="header-input" value={sharesCount ? parseInt(sharesCount).toLocaleString() : ''} onChange={(e) => { const v = e.target.value.replace(/,/g, ''); if (v === '' || /^\d+$/.test(v)) setSharesCount(v); }} placeholder="#" /></div>
              </div>
              <div className="spreadsheet-body">
                {sortedData.map((row) => {
                  const shares = parseInt(sharesCount) || 0;
                  const value = shares > 0 ? Math.round(shares * row.close) : null;
                  const isToday = row.date === getTodayEST();
                  const isLivePrice = isToday && currentMarketState.isRegularHours;
                  const isSettlingClose = isToday && phase === PHASE.SETTLING;

                  return (
                    <div key={row.date} className="spreadsheet-row">
                      <div className="spreadsheet-cell">{dayjs(row.date).format('YYYY-MM-DD')}</div>
                      <div className="spreadsheet-cell">${row.open.toFixed(2)}</div>
                      <div className="spreadsheet-cell">${row.high.toFixed(2)}</div>
                      <div className="spreadsheet-cell">${row.low.toFixed(2)}</div>
                      <div className={`spreadsheet-cell ${isLivePrice ? 'live-price' : ''}${isSettlingClose ? ' settling-close' : ''}`}>${row.close.toFixed(2)}</div>
                      <div className="spreadsheet-cell">{row.volume > 500000 ? (row.volume / 1000000).toFixed(1) + 'M' : '—'}</div>
                      <div className={`spreadsheet-cell ${row.chg !== null ? (row.chg >= 0 ? 'positive' : 'negative') : ''}`}>{row.chg !== null ? `${row.chg >= 0 ? '+' : ''}${row.chg.toFixed(2)}` : '—'}</div>
                      <div className="spreadsheet-cell value-cell">{value !== null && <><span className="currency-toggle" onClick={handleCurrencyToggle} title={`Click to show in ${currency === 'USD' ? 'GBP' : 'USD'}`}>{currencySymbol}</span>{convertValue(value).toLocaleString()}{row.chg !== null && <span className={row.chg >= 0 ? 'positive' : 'negative'}> | {row.chg >= 0 ? '+' : ''}{currencySymbol}{convertValue(Math.round(row.chg * shares)).toLocaleString()}</span>}</>}</div>
                    </div>
                  );
                })}
                {isFetchingMore && (
                  <div className="scroll-loading">
                    <span className="scroll-spinner" />
                    {sortConfig.key !== 'date' && <span style={{ marginLeft: 8 }}>Loading full history…</span>}
                  </div>
                )}
                {hasMoreHistory && !isFetchingMore && sortConfig.key === 'date' && (
                  <div ref={sentinelRef} className="scroll-sentinel" />
                )}
                {!hasMoreHistory && data.length > 130 && (
                  <div className="scroll-exhausted">— end of history —</div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="timestamp">
          Last updated: {dayjs().format('HH:mm MMM D.')}
          <span style={{ marginLeft: '12px', opacity: 0.7 }}>
            Market: {currentMarketState.isRegularHours ? 'Open' : 'Closed'}
          </span>
        </div>
      </div>
    </div>
  );
}
