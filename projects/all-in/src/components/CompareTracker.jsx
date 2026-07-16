import { useState, useEffect, useMemo, useCallback } from 'react';
import CompareChart from './CompareChart';
import AccountPanel from './AccountPanel';
import { WORKER_URL, EST } from '../utils/config';
import { dayjs } from '../utils/marketState';
import { fetchYahooQuote, parseYahooBars } from '../utils/api';
import '../styles/stock-tracker.css';
import '../styles/compare.css';

const REF = 'TSLA';
const DEFAULT_SYMBOLS = ['SPCX', 'GOOGL', 'PLTR'];
const MAX_SYMBOLS = 5; // including TSLA
// NOT stock_/shares_ prefixed — clearCaches() on the tracker page wipes those
const STORAGE_KEY = 'compare_portfolio_v1';
const QUOTE_POLL_MS = 60 * 1000;
const RANGES = ['3M', '6M', '1Y'];
const RANGE_TRADING_DAYS = { '3M': 63, '6M': 126, '1Y': 252 };

const REF_COLOR = '#1a1a1a';
const COLOR_POOL = ['#2d5f8a', '#b8860b', '#7d4a8d', '#2f6f6a'];

const MODE_CAPTIONS = {
  swap: 'TSLA ÷ stock — how many shares of each one TSLA share buys. A peak means TSLA is rich relative to that stock: the moment a partial divestment buys the most.',
  ratio: 'Stock ÷ TSLA — each price as a multiple of TSLA’s. A rising line is outperforming TSLA.',
  indexed: 'All prices rebased to 100 at the start of the range, TSLA included — pure relative performance.',
};

const loadStored = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      symbols: Array.isArray(parsed.symbols) && parsed.symbols.every(s => typeof s === 'string')
        ? parsed.symbols.filter(s => s !== REF).slice(0, MAX_SYMBOLS - 1)
        : undefined,
      shares: parsed.shares && typeof parsed.shares === 'object' ? parsed.shares : undefined,
      priceOverrides: parsed.priceOverrides && typeof parsed.priceOverrides === 'object' ? parsed.priceOverrides : undefined,
    };
  } catch {
    return {};
  }
};

const STORED = loadStored();

export default function CompareTracker() {
  const [symbols, setSymbols] = useState(STORED.symbols ?? DEFAULT_SYMBOLS);
  const [bars, setBars] = useState({});
  const [quotes, setQuotes] = useState({});
  const [mode, setMode] = useState('swap');
  const [range, setRange] = useState('1Y');
  const [shares, setShares] = useState(STORED.shares ?? {});
  const [priceOverrides, setPriceOverrides] = useState(STORED.priceOverrides ?? {});
  const [inputTicker, setInputTicker] = useState('');
  const [tickerError, setTickerError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);

  const allSymbols = useMemo(() => [REF, ...symbols], [symbols]);

  // Stable colours: defaults keep their canonical slot; extras take the first free one
  const colorMap = useMemo(() => {
    const map = { [REF]: REF_COLOR };
    const used = new Set();
    symbols.forEach(s => {
      const idx = DEFAULT_SYMBOLS.indexOf(s);
      if (idx !== -1) { map[s] = COLOR_POOL[idx]; used.add(COLOR_POOL[idx]); }
    });
    symbols.forEach(s => {
      if (!map[s]) { map[s] = COLOR_POOL.find(c => !used.has(c)); used.add(map[s]); }
    });
    return map;
  }, [symbols]);

  // Daily bars: one 1y fetch per symbol covers every range; worker edge-caches 5 min
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fetched = await Promise.all(allSymbols.map(async sym => {
        try {
          const res = await fetch(`${WORKER_URL}/yahoo/${sym}?range=1y&interval=1d`);
          const json = await res.json();
          const result = json?.chart?.result?.[0];
          return [sym, result ? parseYahooBars(result) : []];
        } catch {
          return [sym, []];
        }
      }));
      if (cancelled) return;
      setBars(Object.fromEntries(fetched));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [allSymbols]);

  // Quotes: on load + 60s poll (skipped while the tab is hidden). No WebSocket here.
  const pollQuotes = useCallback(async () => {
    const results = await Promise.all(allSymbols.map(async sym => [sym, await fetchYahooQuote(sym)]));
    setQuotes(prev => {
      const next = { ...prev };
      for (const [sym, q] of results) {
        if (q?.regularMarketPrice != null) {
          next[sym] = { price: q.regularMarketPrice, previousClose: q.previousClose, shortName: q.shortName };
        }
      }
      return next;
    });
    setLastUpdated(dayjs());
  }, [allSymbols]);

  useEffect(() => {
    pollQuotes();
    const id = setInterval(() => { if (!document.hidden) pollQuotes(); }, QUOTE_POLL_MS);
    return () => clearInterval(id);
  }, [pollQuotes]);

  // Persist the what-if portfolio (durable user input, no TTL)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ symbols, shares, priceOverrides }));
    } catch { /* storage full */ }
  }, [symbols, shares, priceOverrides]);

  const handleAddTicker = async (e) => {
    e.preventDefault();
    const sym = inputTicker.trim().toUpperCase();
    if (!sym) return;
    if (sym === REF || symbols.includes(sym)) {
      setTickerError(`${sym} is already in the comparison`);
      return;
    }
    setAdding(true);
    setTickerError(null);
    const quote = await fetchYahooQuote(sym);
    setAdding(false);
    if (quote?.regularMarketPrice == null) {
      setTickerError(`No price data found for ${sym} — check the ticker`);
      return;
    }
    setQuotes(prev => ({ ...prev, [sym]: { price: quote.regularMarketPrice, previousClose: quote.previousClose, shortName: quote.shortName } }));
    setSymbols(prev => [...prev, sym]);
    setInputTicker('');
  };

  const removeSymbol = (sym) => {
    setSymbols(prev => prev.filter(s => s !== sym));
    setShares(prev => { const next = { ...prev }; delete next[sym]; return next; });
    setPriceOverrides(prev => { const next = { ...prev }; delete next[sym]; return next; });
    setTickerError(null);
  };

  // Series derivation: x-axis = TSLA's trading dates in range; a point exists only
  // where the needed closes exist, which clips short-history listings (SPCX) cleanly
  const { series, axisDates, shortHistory } = useMemo(() => {
    const tslaBars = bars[REF];
    if (!tslaBars?.length) return { series: [], axisDates: [], shortHistory: [] };

    const today = dayjs().tz(EST).format('YYYY-MM-DD');
    const closeMap = (sym) => {
      const map = new Map();
      (bars[sym] || []).forEach(b => map.set(b.date, b.close));
      // freshness bridge: today's bar tracks the 60s-polled live price
      const live = quotes[sym]?.price;
      if (live != null && map.has(today)) map.set(today, live);
      return map;
    };

    const axis = tslaBars.slice(-RANGE_TRADING_DAYS[range]).map(b => b.date);
    const tslaMap = closeMap(REF);
    const drawn = mode === 'indexed' ? [REF, ...symbols] : symbols;
    const short = [];

    const out = drawn.map(sym => {
      const map = sym === REF ? tslaMap : closeMap(sym);
      let points = [];
      axis.forEach((date, i) => {
        const c = map.get(date);
        const t = tslaMap.get(date);
        if (c == null || t == null) return;
        const value = mode === 'swap' ? t / c : mode === 'ratio' ? c / t : c;
        points.push({ date, i, value });
      });
      if (mode === 'indexed' && points.length) {
        const base = points[0].value;
        points = points.map(p => ({ ...p, value: 100 * p.value / base }));
      }
      if (points.length && points[0].i > 0) short.push({ symbol: sym, from: points[0].date });
      return { symbol: sym, color: colorMap[sym], points };
    }).filter(s => s.points.length >= 2);

    return { series: out, axisDates: axis, shortHistory: short };
  }, [bars, quotes, mode, range, symbols, colorMap]);

  const formatValue = useCallback((v) => {
    if (mode === 'indexed') return v.toFixed(1);
    if (mode === 'swap') return v >= 10 ? v.toFixed(1) : v.toFixed(2);
    return v < 1 ? v.toFixed(3) : v.toFixed(2);
  }, [mode]);

  // What-if portfolio rows
  const rows = allSymbols.map(sym => {
    const live = quotes[sym]?.price ?? null;
    const override = priceOverrides[sym];
    const price = override != null ? (parseFloat(override) || 0) : live;
    const shareNum = parseFloat(shares[sym]) || 0;
    const value = price != null ? shareNum * price : 0;
    return { sym, live, override, price, value };
  });
  const totalValue = rows.reduce((sum, r) => sum + r.value, 0);

  const setShareCount = (sym, raw) => {
    if (/^\d*\.?\d*$/.test(raw)) setShares(prev => ({ ...prev, [sym]: raw }));
  };

  const setOverride = (sym, raw) => {
    if (/^\d*\.?\d*$/.test(raw)) setPriceOverrides(prev => ({ ...prev, [sym]: raw }));
  };

  const resetOverride = (sym) => {
    setPriceOverrides(prev => { const next = { ...prev }; delete next[sym]; return next; });
  };

  // On commit (Enter/blur), normalise a manual price to 2 dp — '600' becomes '600.00'
  const commitOverride = (sym) => {
    setPriceOverrides(prev => {
      const num = parseFloat(prev[sym]);
      return isNaN(num) ? prev : { ...prev, [sym]: num.toFixed(2) };
    });
  };

  const fmtMoney = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="page-wrapper">
      {loading && <div className="loading"><div className="loading-text">Loading comparison...</div></div>}

      <div className="container compare-stack">
        <header className="header">
          <div className="ticker-display">Compare</div>
          <a href="index.html" className="page-link">← tracker</a>
        </header>

        <div className="box compare-symbols">
          <div className="symbol-chips">
            <span className="symbol-chip">
              <span className="chip-swatch" style={{ background: REF_COLOR }} />{REF}
            </span>
            {symbols.map(sym => (
              <span key={sym} className="symbol-chip">
                <span className="chip-swatch" style={{ background: colorMap[sym] }} />
                {sym}
                <button className="chip-remove" onClick={() => removeSymbol(sym)} aria-label={`Remove ${sym}`}>×</button>
              </span>
            ))}
            {symbols.length < MAX_SYMBOLS - 1 && (
              <form className="chip-add-form" onSubmit={handleAddTicker}>
                <input
                  className="chip-add-input"
                  value={inputTicker}
                  onChange={e => { setInputTicker(e.target.value.toUpperCase()); setTickerError(null); }}
                  placeholder="+ TICKER"
                  maxLength={5}
                  disabled={adding}
                />
              </form>
            )}
          </div>
          {tickerError && <div className="ticker-error negative">{tickerError}</div>}
        </div>

        <div>
          <CompareChart
            series={series}
            axisDates={axisDates}
            mode={mode}
            onModeChange={setMode}
            range={range}
            ranges={RANGES}
            onRangeChange={setRange}
            formatValue={formatValue}
          />
          <div className="chart-caption">{MODE_CAPTIONS[mode]}</div>
          {shortHistory.map(s => (
            <div key={s.symbol} className="chart-footnote">
              {s.symbol} plotted from its first trading day in range ({dayjs(s.from).format('D MMM YYYY')})
            </div>
          ))}
        </div>

        <div className="box portfolio-box">
          <div className="portfolio-title">Portfolio</div>
          <div className="portfolio-scroll">
            <div className="portfolio-grid">
              <div className="portfolio-header">
                <div>Symbol</div>
                <div>Shares</div>
                <div>Price $</div>
                <div>Value</div>
                <div>Weight</div>
              </div>
              {rows.map(r => (
                <div key={r.sym} className="portfolio-row">
                  <div className="portfolio-cell portfolio-symbol">
                    <span className="chip-swatch" style={{ background: colorMap[r.sym] }} />{r.sym}
                  </div>
                  <div className="portfolio-cell">
                    <input
                      className="portfolio-input"
                      value={shares[r.sym] ?? ''}
                      onChange={e => setShareCount(r.sym, e.target.value)}
                      placeholder="0"
                      inputMode="decimal"
                    />
                  </div>
                  <div className="portfolio-cell portfolio-price-cell">
                    <input
                      className={`portfolio-input ${r.override != null ? 'price-overridden' : ''}`}
                      value={r.override ?? (r.live != null ? r.live.toFixed(2) : '')}
                      onChange={e => setOverride(r.sym, e.target.value)}
                      onBlur={() => commitOverride(r.sym)}
                      onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
                      placeholder="—"
                      inputMode="decimal"
                      title={r.override != null ? 'Manual price — ↺ resets to live' : 'Live price (auto-updates) — type to override'}
                    />
                    {r.override != null && (
                      <button className="price-reset" onClick={() => resetOverride(r.sym)} title="Reset to live price">↺</button>
                    )}
                  </div>
                  <div className="portfolio-cell portfolio-value">{r.value > 0 ? fmtMoney(r.value) : '—'}</div>
                  <div className="portfolio-cell">{totalValue > 0 && r.value > 0 ? ((r.value / totalValue) * 100).toFixed(1) + '%' : '—'}</div>
                </div>
              ))}
              <div className="portfolio-row portfolio-total">
                <div className="portfolio-cell">Total</div>
                <div className="portfolio-cell" />
                <div className="portfolio-cell" />
                <div className="portfolio-cell portfolio-value">{totalValue > 0 ? fmtMoney(totalValue) : '—'}</div>
                <div className="portfolio-cell">{totalValue > 0 ? '100.0%' : '—'}</div>
              </div>
            </div>
          </div>
        </div>

        <AccountPanel
          workingState={{ symbols, shares, priceOverrides }}
          onLoadPortfolio={(data) => {
            setSymbols(data.symbols);
            setShares(data.shares || {});
            setPriceOverrides(data.priceOverrides || {});
          }}
        />

        {lastUpdated && (
          <div className="timestamp">Last updated {lastUpdated.tz(EST).format('h:mm:ss A')} EST</div>
        )}
      </div>
    </div>
  );
}
