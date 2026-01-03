import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import StockChart from './StockChart';
import { WORKER_URL } from '../utils/config';
import { dayjs, getMarketState, getTodayEST, MarketState } from '../utils/marketState';
import { getCachedData, setCachedData } from '../utils/cache';
import { fetchPriceData, fetchMarketClock } from '../utils/api';
import { EST } from '../utils/config';
import '../styles/stock-tracker.css';

export default function StockTracker() {
  const [ticker, setTicker] = useState('TSLA');
  const [inputTicker, setInputTicker] = useState('');
  const [data, setData] = useState([]);
  const [chartData, setChartData] = useState([]);
  const [intradayData, setIntradayData] = useState([]);
  const [weeklyData, setWeeklyData] = useState([]);
  const [monthlyData, setMonthlyData] = useState([]);
  const [timeframe, setTimeframe] = useState('6M');
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [priceFlash, setPriceFlash] = useState(null);
  const [sortConfig, setSortConfig] = useState({ key: 'date', direction: 'desc' });
  const [sharesCount, setSharesCount] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [chartCache, setChartCache] = useState({});
  const [currentMarketState, setCurrentMarketState] = useState(getMarketState());
  const [clockData, setClockData] = useState(null);

  const lastPriceRef = useRef(null);
  const wsRef = useRef(null);
  const isConnectingRef = useRef(false);
  const clockDataRef = useRef(null);

  // Fetch market clock on mount and every 5 minutes
  useEffect(() => {
    const loadClock = async () => {
      const clock = await fetchMarketClock();
      if (clock) {
        clockDataRef.current = clock; // Update ref immediately (before state triggers effects)
        setClockData(clock);
      }
    };

    loadClock();
    const clockInterval = setInterval(loadClock, 5 * 60 * 1000); // Refresh every 5 min

    return () => clearInterval(clockInterval);
  }, []);

  // Market state monitoring - uses clock data for accuracy
  useEffect(() => {
    const interval = setInterval(() => {
      const newState = getMarketState(clockData);
      setCurrentMarketState(prev => {
        if (prev.state !== newState.state) {
          return newState;
        }
        return prev;
      });
    }, 1000); // Check every second for instant state changes

    return () => clearInterval(interval);
  }, [clockData]);

  // Main data fetcher
  const fetchStockData = async (symbol) => {
    setLoading(true);
    const marketState = getMarketState(clockDataRef.current);

    try {
      const { data: priceData } = await fetchPriceData(symbol, clockDataRef.current);

      if (priceData) {
        setCompanyName(priceData.shortName || symbol);
      }

      let historicalData = getCachedData(symbol);
      if (!historicalData) {
        const barsRes = await fetch(`${WORKER_URL}/yahoo/${symbol}?range=6mo&interval=1d`);
        const barsData = await barsRes.json();
        if (barsData?.chart?.result?.[0]) {
          const result = barsData.chart.result[0];
          const timestamps = result.timestamp;
          const quote = result.indicators.quote[0];
          if (timestamps && quote) {
            historicalData = timestamps.map((t, i) => ({
              date: dayjs.unix(t).tz(EST).format('YYYY-MM-DD'),
              open: quote.open[i],
              high: quote.high[i],
              low: quote.low[i],
              close: quote.close[i],
              volume: quote.volume[i] || 0
            })).filter(day => day.close !== null)
              .sort((a, b) => dayjs(a.date).unix() - dayjs(b.date).unix());
            setCachedData(symbol, historicalData);
          }
        }
      }

      if (historicalData?.length >= 2 && priceData) {
        const previousClose = priceData.previousClose || historicalData[historicalData.length - 2].close;
        const change = priceData.currentPrice - previousClose;

        setQuote({
          c: priceData.currentPrice,
          o: priceData.open,
          h: priceData.high,
          l: priceData.low,
          pc: previousClose,
          d: change,
          dp: (change / previousClose) * 100,
          volume: priceData.volume,
          tradingDay: priceData.tradingDay,
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

      if (historicalData?.length > 0) setData(historicalData);
    } catch (error) {
      console.error('Error:', error);
    }
    setLoading(false);
  };

  // Chart data fetcher - always fetches 5Y data for continuous zoom
  const fetchChartData = useCallback(async (symbol) => {
    const cacheKey = `${symbol}-5Y`;

    // Return cached 5Y data if available
    if (chartCache[cacheKey]) {
      setChartData(chartCache[cacheKey]);
      return;
    }

    try {
      const barsRes = await fetch(`${WORKER_URL}/yahoo/${symbol}?range=5y&interval=1d`);
      const barsData = await barsRes.json();

      if (barsData?.chart?.result?.[0]) {
        const result = barsData.chart.result[0];
        const timestamps = result.timestamp;
        const quote = result.indicators.quote[0];
        if (timestamps && quote) {
          const chartBars = timestamps.map((t, i) => ({
            date: dayjs.unix(t).tz(EST).toISOString(),
            open: quote.open[i],
            high: quote.high[i],
            low: quote.low[i],
            close: quote.close[i],
            volume: quote.volume[i] || 0
          })).filter(b => b.close !== null);

          setChartData(chartBars);
          setChartCache(prev => ({ ...prev, [cacheKey]: chartBars }));
        }
      }
    } catch (error) {
      console.error('Error fetching chart data:', error);
    }
  }, [chartCache]);

  // Intraday data fetcher for 1D view (5-min intervals)
  const fetchIntradayData = useCallback(async (symbol) => {
    try {
      const barsRes = await fetch(`${WORKER_URL}/yahoo/${symbol}?range=1d&interval=5m`);
      const barsData = await barsRes.json();

      if (barsData?.chart?.result?.[0]) {
        const result = barsData.chart.result[0];
        const timestamps = result.timestamp;
        const quote = result.indicators.quote[0];
        if (timestamps && quote) {
          const intradayBars = timestamps.map((t, i) => ({
            date: dayjs.unix(t).tz(EST).toISOString(),
            open: quote.open[i],
            high: quote.high[i],
            low: quote.low[i],
            close: quote.close[i],
            volume: quote.volume[i] || 0
          })).filter(b => b.close !== null);

          setIntradayData(intradayBars);
        }
      }
    } catch (error) {
      console.error('Error fetching intraday data:', error);
    }
  }, []);

  // Weekly data fetcher for 1W view (15-min intervals)
  const fetchWeeklyData = useCallback(async (symbol) => {
    try {
      const barsRes = await fetch(`${WORKER_URL}/yahoo/${symbol}?range=5d&interval=15m`);
      const barsData = await barsRes.json();

      if (barsData?.chart?.result?.[0]) {
        const result = barsData.chart.result[0];
        const timestamps = result.timestamp;
        const quote = result.indicators.quote[0];
        if (timestamps && quote) {
          const weeklyBars = timestamps.map((t, i) => ({
            date: dayjs.unix(t).tz(EST).toISOString(),
            open: quote.open[i],
            high: quote.high[i],
            low: quote.low[i],
            close: quote.close[i],
            volume: quote.volume[i] || 0
          })).filter(b => b.close !== null);

          setWeeklyData(weeklyBars);
        }
      }
    } catch (error) {
      console.error('Error fetching weekly data:', error);
    }
  }, []);

  // Monthly data fetcher for 6D-60D view (1-hour intervals)
  const fetchMonthlyData = useCallback(async (symbol) => {
    try {
      const barsRes = await fetch(`${WORKER_URL}/yahoo/${symbol}?range=60d&interval=1h`);
      const barsData = await barsRes.json();

      if (barsData?.chart?.result?.[0]) {
        const result = barsData.chart.result[0];
        const timestamps = result.timestamp;
        const quote = result.indicators.quote[0];
        if (timestamps && quote) {
          const monthlyBars = timestamps.map((t, i) => ({
            date: dayjs.unix(t).tz(EST).toISOString(),
            open: quote.open[i],
            high: quote.high[i],
            low: quote.low[i],
            close: quote.close[i],
            volume: quote.volume[i] || 0
          })).filter(b => b.close !== null);

          setMonthlyData(monthlyBars);
        }
      }
    } catch (error) {
      console.error('Error fetching monthly data:', error);
    }
  }, []);

  // Initial load and ticker changes
  useEffect(() => {
    setChartCache({});
    lastPriceRef.current = null;
    fetchStockData(ticker);
  }, [ticker]);

  // Re-fetch when clock data first loads (fixes race condition)
  useEffect(() => {
    if (clockData && ticker) {
      fetchStockData(ticker);
    }
  }, [clockData]);

  useEffect(() => {
    if (ticker) fetchChartData(ticker);
  }, [ticker, fetchChartData]);

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

    const MAX_RECONNECT_ATTEMPTS = 10;
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
              const newPrice = msg.data[msg.data.length - 1]?.p;
              if (newPrice == null) return;
              if (lastPriceRef.current === newPrice) return;
              const oldPrice = lastPriceRef.current;
              const direction = oldPrice === null || newPrice >= oldPrice ? 'up' : 'down';
              lastPriceRef.current = newPrice;

              setQuote(prev => {
                if (!prev) return prev;
                const change = newPrice - prev.pc;
                return {
                  ...prev,
                  c: newPrice,
                  d: change,
                  dp: (change / prev.pc) * 100,
                  h: Math.max(prev.h || newPrice, newPrice),
                  l: Math.min(prev.l || newPrice, newPrice)
                };
              });
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
        };

        ws.onclose = () => {
          clearTimeout(connectionTimeout);
          isConnectingRef.current = false;
          wsRef.current = null;
          currentSubscribedSymbol = null;

          if (isMounted && getMarketState(clockDataRef.current).isRegularHours) {
            scheduleReconnect();
          }
        };

      } catch (e) {
        clearTimeout(fetchTimeout);
        isConnectingRef.current = false;
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

  // Fetch intraday, weekly, and monthly data on load and refresh during market hours
  useEffect(() => {
    if (!ticker) return;

    // Always fetch on load
    fetchIntradayData(ticker);
    fetchWeeklyData(ticker);
    fetchMonthlyData(ticker);

    // Poll during market hours
    if (!currentMarketState.isRegularHours) return;

    const interval = setInterval(() => {
      fetchIntradayData(ticker);
      fetchWeeklyData(ticker);
      fetchMonthlyData(ticker);
    }, 60000);

    return () => clearInterval(interval);
  }, [ticker, currentMarketState.state, fetchIntradayData, fetchWeeklyData, fetchMonthlyData]);

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
    const interval = setInterval(pollExtendedHours, 5000);

    return () => {
      console.log('Extended hours polling stopped');
      clearInterval(interval);
    };
  }, [ticker, currentMarketState.state]);

  // Spreadsheet data processing
  const processSpreadsheetData = useMemo(() => {
    const dataWithToday = [...data];
    const todayEST = getTodayEST();
    const apiTradingDay = quote?.tradingDay;
    const shouldProcessTodayRow = apiTradingDay === todayEST || currentMarketState.isRegularHours;

    const toDateStr = (d) => d ? dayjs(d).format('YYYY-MM-DD') : null;
    const historicalDataHasToday = toDateStr(data[data.length - 1]?.date) === todayEST;

    if (shouldProcessTodayRow && quote?.c) {
      if (historicalDataHasToday) {
        const todayIndex = dataWithToday.findIndex(d => toDateStr(d.date) === todayEST);
        if (todayIndex !== -1) {
          dataWithToday[todayIndex] = {
            ...dataWithToday[todayIndex],
            open: quote.o || dataWithToday[todayIndex].open,
            high: quote.h || dataWithToday[todayIndex].high,
            low: quote.l || dataWithToday[todayIndex].low,
            close: quote.c,
            volume: quote.volume || dataWithToday[todayIndex].volume,
            isToday: currentMarketState.isRegularHours
          };
        }
      } else {
        dataWithToday.push({
          date: todayEST,
          open: quote.o || quote.c,
          high: quote.h || quote.c,
          low: quote.l || quote.c,
          close: quote.c,
          volume: quote.volume || 0,
          isToday: currentMarketState.isRegularHours
        });
      }
    }

    const cleanedData = dataWithToday.filter(d => !(d.isToday && toDateStr(d.date) !== todayEST));

    const dataWithChange = cleanedData.map((row, index) => ({
      ...row,
      chg: index === 0 ? null : row.close - cleanedData[index - 1].close
    }));

    return dataWithChange;
  }, [data, quote, currentMarketState]);

  const sortedData = useMemo(() => {
    return [...processSpreadsheetData].sort((a, b) => {
      if (a[sortConfig.key] < b[sortConfig.key]) return sortConfig.direction === 'asc' ? -1 : 1;
      if (a[sortConfig.key] > b[sortConfig.key]) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [processSpreadsheetData, sortConfig]);

  // Derived values
  const currentPrice = quote?.c || data[data.length - 1]?.close || 0;
  const lastTwo = processSpreadsheetData.slice(-2);
  const todayChange = lastTwo.length === 2 ? lastTwo[1].close - lastTwo[0].close : 0;
  const todayChangePercent = lastTwo.length === 2 ? (todayChange / lastTwo[0].close) * 100 : 0;
  const dayHigh = quote?.h || data[data.length - 1]?.high || 0;
  const dayLow = quote?.l || data[data.length - 1]?.low || 0;
  const avgVolume = data.length > 0 ? data.reduce((sum, d) => sum + d.volume, 0) / data.length : 0;
  const week52High = quote?.fiftyTwoWeekHigh || (data.length > 0 ? Math.max(...data.map(d => d.high)) : 0);
  const week52Low = quote?.fiftyTwoWeekLow || (data.length > 0 ? Math.min(...data.map(d => d.low)) : 0);
  const marketCap = quote?.sharesOutstanding ? (quote.sharesOutstanding * currentPrice) / 1e6 : 0;
  const forwardPE = quote?.forwardPE || 0;

  // Handlers
  const handleTickerSubmit = (e) => {
    e.preventDefault();
    if (inputTicker.trim()) {
      setTicker(inputTicker.toUpperCase());
      setInputTicker('');
      setSharesCount('');
    }
  };

  const handleSort = (key) => {
    setSortConfig(prev => ({ key, direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc' }));
  };

  return (
    <div className="page-wrapper">
      {loading && <div className="loading"><div className="loading-text">Loading {ticker}...</div></div>}

      <div className="container">
        <header className="header">
          <div className="ticker-display">{companyName || ticker}</div>
          <form className="ticker-form" onSubmit={handleTickerSubmit}>
            <input type="text" className="ticker-input" value={inputTicker} onChange={(e) => setInputTicker(e.target.value)} placeholder="TICKER" maxLength={5} />
          </form>
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
                <div className={`status-dot ${currentMarketState.isRegularHours ? 'open' : 'closed'}`}></div>
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
            </div>
          </div>

          <div className="chart-wrapper">
            <StockChart
              chartData={chartData}
              intradayData={intradayData}
              weeklyData={weeklyData}
              monthlyData={monthlyData}
              timeframe={timeframe}
              onTimeframeChange={setTimeframe}
              previousClose={quote?.pc}
            />
          </div>
        </div>

        <div className="box spreadsheet" style={{marginTop: '20px'}}>
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
                  const isLivePrice = row.isToday && currentMarketState.isRegularHours;

                  return (
                    <div key={row.date} className="spreadsheet-row">
                      <div className="spreadsheet-cell">{dayjs(row.date).format('YYYY-MM-DD')}</div>
                      <div className="spreadsheet-cell">${row.open.toFixed(2)}</div>
                      <div className="spreadsheet-cell">${row.high.toFixed(2)}</div>
                      <div className="spreadsheet-cell">${row.low.toFixed(2)}</div>
                      <div className={`spreadsheet-cell ${isLivePrice ? 'live-price' : ''}`}>${row.close.toFixed(2)}</div>
                      <div className="spreadsheet-cell">{row.volume > 500000 ? (row.volume / 1000000).toFixed(0) + 'M' : '—'}</div>
                      <div className={`spreadsheet-cell ${row.chg !== null ? (row.chg >= 0 ? 'positive' : 'negative') : ''}`}>{row.chg !== null ? `${row.chg >= 0 ? '+' : ''}${row.chg.toFixed(2)}` : '—'}</div>
                      <div className="spreadsheet-cell value-cell">{value !== null && <>${value.toLocaleString()}{row.chg !== null && <span className={row.chg >= 0 ? 'positive' : 'negative'}> | {row.chg >= 0 ? '+' : ''}${Math.round(row.chg * shares).toLocaleString()}</span>}</>}</div>
                    </div>
                  );
                })}
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
