import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { dayjs } from '../utils/marketState';
import weekOfYear from 'dayjs/plugin/weekOfYear';
import { EST } from '../utils/config';

dayjs.extend(weekOfYear);

const MIN_DAYS = 1;
const MAX_DAYS = 1825; // 5 years

// Map timeframe buttons to days
const TIMEFRAME_DAYS = {
  '1D': 1,
  '1W': 7,
  '1M': 30,
  '3M': 90,
  '6M': 180,
  'YTD': null, // Calculate dynamically
  '1Y': 365,
  '5Y': 1825
};

export default function StockChart({ chartData, intradayData, weeklyData, monthlyData, timeframe, onTimeframeChange, previousClose }) {
  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const [hoverData, setHoverData] = useState(null);
  const [chartType, setChartType] = useState('line'); // 'line' or 'candle'
  const [visibleDays, setVisibleDays] = useState(180); // Default ~6 months
  const [dragStart, setDragStart] = useState(null); // For drag selection

  // Calculate YTD days
  const getYTDDays = () => {
    const now = dayjs();
    const startOfYear = now.startOf('year');
    return now.diff(startOfYear, 'day') + 1;
  };

  // Toggle chart type with 's' key when focused
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 's' || e.key === 'S') {
        setChartType(prev => prev === 'line' ? 'candle' : 'line');
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener('keydown', handleKeyDown);
      return () => container.removeEventListener('keydown', handleKeyDown);
    }
  }, []);

  // Sync visibleDays when timeframe button is clicked
  useEffect(() => {
    const days = timeframe === 'YTD' ? getYTDDays() : TIMEFRAME_DAYS[timeframe];
    if (days) setVisibleDays(days);
  }, [timeframe]);

  // Continuous wheel zoom handler with proper scroll prevention
  // Zoom only works for 1W-5Y range; 1D is fixed and not zoomable
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e) => {
      // Only zoom when chart is focused (clicked)
      if (document.activeElement !== container) return;
      e.preventDefault();
      e.stopPropagation();
      setVisibleDays(prev => {
        // Don't zoom if on 1D view
        if (prev <= 1) return prev;

        // Use floor for zoom in, ceil for zoom out to ensure we always change
        if (e.deltaY > 0) {
          // Zoom out
          const next = Math.ceil(prev * 1.15);
          return Math.min(MAX_DAYS, next === prev ? prev + 1 : next);
        } else {
          // Zoom in - minimum is 1W (7 days)
          const next = Math.floor(prev * 0.85);
          return Math.max(7, next === prev ? prev - 1 : next);
        }
      });
    };

    // Use { passive: false } to allow preventDefault
    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // Helper: slice data to show last N trading days
  const sliceByTradingDays = useCallback((data, numDays) => {
    if (!data?.length) return [];
    const days = [...new Set(data.map(d => dayjs(d.date).format('YYYY-MM-DD')))].sort();
    const cutoffDays = new Set(days.slice(-numDays));
    return data.filter(d => cutoffDays.has(dayjs(d.date).format('YYYY-MM-DD')));
  }, []);

  // Determine which data source to use and slice appropriately
  const visibleData = useMemo(() => {
    // 1D: intraday (5-min intervals)
    if (visibleDays <= 1) {
      if (intradayData?.length) return intradayData;
      // Fallback to weekly data
      if (weeklyData?.length) return sliceByTradingDays(weeklyData, 1);
    }

    // 2-5D: weekly (15-min intervals)
    if (visibleDays <= 5 && weeklyData?.length) {
      const result = sliceByTradingDays(weeklyData, visibleDays);
      if (result.length) return result;
    }

    // 6-60D: monthly (1-hour intervals)
    if (visibleDays <= 60 && monthlyData?.length) {
      const result = sliceByTradingDays(monthlyData, visibleDays);
      if (result.length) return result;
    }

    // 61D+: daily data - filter by calendar days from today
    if (chartData?.length) {
      const cutoffDate = dayjs().subtract(visibleDays, 'day').format('YYYY-MM-DD');
      return chartData.filter(d => dayjs(d.date).format('YYYY-MM-DD') >= cutoffDate);
    }

    return [];
  }, [chartData, intradayData, weeklyData, monthlyData, visibleDays, sliceByTradingDays]);

  // Early market: data spans < 2 hours, scale to 2-hour window instead of full day
  const earlyMarket = useMemo(() => {
    if (visibleDays > 1 || !visibleData || visibleData.length < 2) return false;
    const first = dayjs(visibleData[0].date).tz(EST);
    const last = dayjs(visibleData[visibleData.length - 1].date).tz(EST);
    return last.diff(first, 'minute') / 60 < 2;
  }, [visibleDays, visibleData]);

  // Calculate chart paths and candles from visible data
  const { minPrice, maxPrice, priceRange, linePath, areaPath, candles } = useMemo(() => {
    if (!visibleData?.length) return { minPrice: 0, maxPrice: 100, priceRange: 100, linePath: '', areaPath: '', candles: [] };

    // Filter out any data points with null/undefined values
    const validData = visibleData.filter(d =>
      d.low != null && d.high != null && d.close != null && d.open != null &&
      isFinite(d.low) && isFinite(d.high) && isFinite(d.close) && isFinite(d.open)
    );
    if (validData.length < 2) return { minPrice: 0, maxPrice: 100, priceRange: 100, linePath: '', areaPath: '', candles: [] };

    let min = Math.min(...validData.map(d => d.low));
    let max = Math.max(...validData.map(d => d.high));
    // Include previous close in 1D range so the reference line is always visible
    if (visibleDays <= 1 && previousClose) {
      min = Math.min(min, previousClose);
      max = Math.max(max, previousClose);
    }
    // Expand range to fit nice Y-axis labels
    const rawRange = (max - min) || 1;
    const rawStep = rawRange / 3;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    let labelStep;
    if (norm <= 1.5) labelStep = 1 * mag;
    else if (norm <= 3.5) labelStep = 2 * mag;
    else if (norm <= 7.5) labelStep = 5 * mag;
    else labelStep = 10 * mag;
    if (labelStep >= 2 && labelStep % 2 !== 0) labelStep = Math.round(labelStep / 2) * 2;
    const center = (min + max) / 2;
    const rc = Math.round(center / labelStep) * labelStep;
    min = Math.min(min, rc - 1.5 * labelStep) - rawRange * 0.01;
    max = Math.max(max, rc + 1.5 * labelStep) + rawRange * 0.01;
    const range = (max - min) || 1;
    const calcY = (price) => 260 - ((price - min) / range) * 240;

    const calcX = (d, i) => {
      // For intraday (1D), use time-based positioning
      if (visibleDays <= 1) {
        const estTime = dayjs(d.date).tz(EST);
        const timeInHours = Math.max(9.5, Math.min(16, estTime.hour() + estTime.minute() / 60));
        // Early market: scale to 2-hour window (9:30–11:30) instead of full day
        const span = earlyMarket ? 2 : 6.5;
        return 50 + ((timeInHours - 9.5) / span) * 720;
      }
      // For longer periods, use index-based positioning
      return 50 + (i / (validData.length - 1 || 1)) * 720;
    };

    const line = validData.length > 1
      ? validData.map((d, i) => `${i === 0 ? 'M' : 'L'} ${calcX(d, i)} ${calcY(d.close)}`).join(' ')
      : '';
    const area = line
      ? `${line} L ${calcX(validData[validData.length - 1], validData.length - 1)} 260 L ${calcX(validData[0], 0)} 260 Z`
      : '';

    // Calculate candlestick data
    const candleWidth = Math.max(2, Math.min(8, 600 / validData.length));
    const candleData = validData.map((d, i) => {
      const x = calcX(d, i);
      const isGreen = d.close >= d.open;
      const bodyTop = calcY(Math.max(d.open, d.close));
      const bodyBottom = calcY(Math.min(d.open, d.close));
      const bodyHeight = Math.max(1, bodyBottom - bodyTop);

      return {
        x,
        wickTop: calcY(d.high),
        wickBottom: calcY(d.low),
        bodyTop,
        bodyHeight,
        width: candleWidth,
        isGreen
      };
    });

    return { minPrice: min, maxPrice: max, priceRange: range, linePath: line, areaPath: area, candles: candleData };
  }, [visibleData, visibleDays, earlyMarket, previousClose]);

  // Determine chart color based on price movement
  let isChartPositive = true;
  if (visibleData?.length > 0) {
    if (visibleDays <= 1) {
      const baseline = previousClose || visibleData[0]?.close || 0;
      isChartPositive = (visibleData[visibleData.length - 1]?.close || 0) >= baseline;
    } else {
      isChartPositive = (visibleData[visibleData.length - 1]?.close || 0) >= (visibleData[0]?.close || 0);
    }
  }
  const chartColor = isChartPositive ? '#137333' : '#a50e0e';

  // Mouse move handler for hover data
  const handleMouseMove = useCallback((e) => {
    if (!visibleData?.length || !svgRef.current) return;

    const svgRect = svgRef.current.getBoundingClientRect();
    const scaleX = 800 / svgRect.width;
    let mouseX = Math.max(50, Math.min(770, (e.clientX - svgRect.left) * scaleX));

    let index, dataX;

    if (visibleDays <= 1) {
      // Intraday: find nearest point by time
      const span = earlyMarket ? 2 : 6.5;
      const mouseTimeHours = 9.5 + ((mouseX - 50) / 720) * span;
      let nearestIndex = 0, nearestDiff = Infinity;

      visibleData.forEach((d, i) => {
        const estTime = dayjs(d.date).tz(EST);
        const timeInHours = estTime.hour() + estTime.minute() / 60;
        const diff = Math.abs(timeInHours - mouseTimeHours);
        if (diff < nearestDiff) { nearestDiff = diff; nearestIndex = i; }
      });

      index = nearestIndex;
      const point = visibleData[index];
      if (!point) return;
      const estTime = dayjs(point.date).tz(EST);
      const timeInHours = Math.max(9.5, Math.min(16, estTime.hour() + estTime.minute() / 60));
      dataX = 50 + ((timeInHours - 9.5) / span) * 720;
    } else {
      // Longer periods: find by position
      const ratio = (mouseX - 50) / 720;
      const dataLength = visibleData.length - 1 || 1;
      index = Math.min(Math.max(0, Math.round(ratio * dataLength)), visibleData.length - 1);
      dataX = 50 + (index / dataLength) * 720;
    }

    if (index >= 0 && index < visibleData.length) {
      const point = visibleData[index];
      if (point?.close != null) {
        const yPos = 260 - ((point.close - minPrice) / (priceRange || 1)) * 240;
        setHoverData({ dataX, y: yPos, data: point });
      }
    }
  }, [visibleData, visibleDays, earlyMarket, minPrice, priceRange]);

  // Mouse down handler for drag selection
  const handleMouseDown = useCallback((e) => {
    if (!visibleData?.length || !svgRef.current) return;

    const svgRect = svgRef.current.getBoundingClientRect();
    const scaleX = 800 / svgRect.width;
    let mouseX = Math.max(50, Math.min(770, (e.clientX - svgRect.left) * scaleX));

    let index, dataX;

    if (visibleDays <= 1) {
      const span = earlyMarket ? 2 : 6.5;
      const mouseTimeHours = 9.5 + ((mouseX - 50) / 720) * span;
      let nearestIndex = 0, nearestDiff = Infinity;
      visibleData.forEach((d, i) => {
        const estTime = dayjs(d.date).tz(EST);
        const timeInHours = estTime.hour() + estTime.minute() / 60;
        const diff = Math.abs(timeInHours - mouseTimeHours);
        if (diff < nearestDiff) { nearestDiff = diff; nearestIndex = i; }
      });
      index = nearestIndex;
      const point = visibleData[index];
      if (!point) return;
      const estTime = dayjs(point.date).tz(EST);
      const timeInHours = Math.max(9.5, Math.min(16, estTime.hour() + estTime.minute() / 60));
      dataX = 50 + ((timeInHours - 9.5) / span) * 720;
    } else {
      const ratio = (mouseX - 50) / 720;
      const dataLength = visibleData.length - 1 || 1;
      index = Math.min(Math.max(0, Math.round(ratio * dataLength)), visibleData.length - 1);
      dataX = 50 + (index / dataLength) * 720;
    }

    if (index >= 0 && index < visibleData.length) {
      const point = visibleData[index];
      if (point?.close != null) {
        const yPos = 260 - ((point.close - minPrice) / (priceRange || 1)) * 240;
        setDragStart({ dataX, y: yPos, data: point });
      }
    }
  }, [visibleData, visibleDays, earlyMarket, minPrice, priceRange]);

  // Mouse up handler to clear drag selection
  const handleMouseUp = useCallback(() => {
    setDragStart(null);
  }, []);

  // Y-axis labels — exactly 4 round-number labels with even jumps
  const getYAxisLabels = () => {
    if (!minPrice || !maxPrice || !isFinite(minPrice) || !isFinite(maxPrice) || !priceRange) return [];
    // Nice round even step so 4 labels span roughly the price range
    const rawStep = priceRange / 3;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    let step;
    if (norm <= 1.5) step = 1 * mag;
    else if (norm <= 3.5) step = 2 * mag;
    else if (norm <= 7.5) step = 5 * mag;
    else step = 10 * mag;
    if (step >= 2 && step % 2 !== 0) step = Math.round(step / 2) * 2;
    // Centre 4 labels around the data midpoint
    const center = (minPrice + maxPrice) / 2;
    const rc = Math.round(center / step) * step;
    const labels = [rc - 1.5 * step, rc - 0.5 * step, rc + 0.5 * step, rc + 1.5 * step];
    return labels.map(p => ({
      label: `$${Number.isInteger(p) ? p : p.toFixed(2)}`,
      top: ((260 - ((p - minPrice) / priceRange) * 240) / 300) * 100
    }));
  };

  // Dynamic X-axis labels based on visible range
  const getXAxisLabels = () => {
    if (!visibleData?.length) return [];
    try {

    let allLabels = [];

    if (visibleDays <= 1 && earlyMarket) {
      // Early market: show half-hour labels across the 2-hour window (9:30–11:30)
      const labels = ['9:30','10:00','10:30','11:00','11:30'];
      allLabels = labels.map(label => {
        const [h, m] = label.split(':').map(Number);
        const timeInHours = h + m / 60;
        return { label, x: 50 + ((timeInHours - 9.5) / 2) * 720 };
      });
    } else if (visibleDays <= 1) {
      // Intraday: show hours from 9:30 to 16:00
      allLabels = ['10:00','11:00','12:00','13:00','14:00','15:00','16:00'].map((label, idx, arr) => {
        const hour = parseInt(label.split(':')[0]);
        let x = 50 + ((hour - 9.5) / 6.5) * 720;
        if (idx === 0) x += 15;
        if (idx === arr.length - 1) x -= 15;
        return { label, x };
      });
    } else if (visibleDays <= 7) {
      // Week or less: show day names
      const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const seen = new Set();
      visibleData.forEach((d, i) => {
        const date = dayjs(d.date).format('YYYY-MM-DD');
        if (seen.has(date)) return;
        seen.add(date);
        allLabels.push({
          label: days[dayjs(d.date).day()],
          x: 50 + (i / (visibleData.length - 1 || 1)) * 720
        });
      });
    } else if (visibleDays <= 60) {
      // Up to 2 months: show week markers or specific dates
      const seen = new Set();
      visibleData.forEach((d, i) => {
        const dt = dayjs(d.date);
        const weekKey = `${dt.year()}-W${dt.week()}`;
        if (seen.has(weekKey)) return;
        seen.add(weekKey);
        allLabels.push({
          label: dt.format('MMM D'),
          x: 50 + (i / (visibleData.length - 1 || 1)) * 720
        });
      });
      // Limit to ~6 labels
      if (allLabels.length > 6) {
        const step = Math.ceil(allLabels.length / 6);
        allLabels = allLabels.filter((_, i) => i % step === 0);
      }
    } else if (visibleDays <= 365) {
      // Up to 1 year: show months
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const seen = new Set();
      visibleData.forEach((d, i) => {
        const dt = dayjs(d.date);
        const key = `${dt.year()}-${dt.month()}`;
        if (seen.has(key)) return;
        seen.add(key);
        allLabels.push({
          label: months[dt.month()],
          x: 50 + (i / (visibleData.length - 1 || 1)) * 720
        });
      });
      // Cap labels: max 12 (1Y/late-Dec YTD), scales down for shorter ranges
      const maxLabels = Math.min(12, Math.ceil(visibleDays / 30));
      if (allLabels.length > maxLabels) {
        allLabels = allLabels.slice(allLabels.length - maxLabels);
      }
    } else {
      // Multi-year: show years
      const seen = new Set();
      visibleData.forEach((d, i) => {
        const year = dayjs(d.date).year();
        if (seen.has(year)) return;
        seen.add(year);
        allLabels.push({
          label: String(year).slice(-2),
          x: 50 + (i / (visibleData.length - 1 || 1)) * 720
        });
      });
    }

    // Return with x coordinates for SVG positioning
    return allLabels;
    } catch (e) {
      console.error('Error generating X-axis labels:', e);
      return [];
    }
  };

  const yLabels = getYAxisLabels();
  const xLabels = getXAxisLabels();

  // Determine which timeframe button is "active" (closest match)
  const getActiveTimeframe = () => {
    const ytdDays = getYTDDays();
    const thresholds = [
      { tf: '1D', days: 1 },
      { tf: '1W', days: 7 },
      { tf: '1M', days: 30 },
      { tf: '3M', days: 90 },
      { tf: '6M', days: 180 },
      { tf: 'YTD', days: ytdDays },
      { tf: '1Y', days: 365 },
      { tf: '5Y', days: 1825 }
    ];

    // Find closest match
    let closest = thresholds[0];
    let minDiff = Math.abs(visibleDays - thresholds[0].days);
    for (const t of thresholds) {
      const diff = Math.abs(visibleDays - t.days);
      if (diff < minDiff) {
        minDiff = diff;
        closest = t;
      }
    }
    // Only highlight if within 10% of the preset
    if (minDiff / closest.days < 0.1) return closest.tf;
    return null;
  };

  const activeTimeframe = getActiveTimeframe();

  return (
    <div className="box chart-box" ref={containerRef} tabIndex={0} style={{ outline: 'none' }}>
      <div className="timeframe-controls">
        {['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', '5Y'].map((tf, idx, arr) => (
          <span key={tf}>
            <button
              className={`timeframe-btn ${activeTimeframe === tf ? 'active' : ''}`}
              onClick={() => {
                const days = tf === 'YTD' ? getYTDDays() : TIMEFRAME_DAYS[tf];
                setVisibleDays(days);
                onTimeframeChange(tf);
              }}
            >
              {tf}
            </button>
            {idx < arr.length - 1 && <span className="timeframe-pipe">|</span>}
          </span>
        ))}
      </div>

      {/* Y-axis labels */}
      {yLabels.map((item, idx) => (
        <div key={idx} style={{
          position: 'absolute',
          left: '8px',
          top: `${item.top}%`,
          transform: 'translateY(-50%)',
          fontSize: '11px',
          color: '#80868b',
          fontFamily: 'IBM Plex Mono',
          pointerEvents: 'none'
        }}>
          {item.label}
        </div>
      ))}

      <svg
        ref={svgRef}
        viewBox="0 0 800 300"
        preserveAspectRatio="none"
        style={{ width: '100%', height: '100%', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { setHoverData(null); setDragStart(null); }}
      >
        <defs>
          <linearGradient id="grad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={isChartPositive ? 'rgba(19,115,51,0.2)' : 'rgba(165,14,14,0.2)'} />
            <stop offset="100%" stopColor={isChartPositive ? 'rgba(19,115,51,0)' : 'rgba(165,14,14,0)'} />
          </linearGradient>
        </defs>

        {/* X-axis line */}
        <line x1="50" y1="280" x2="770" y2="280" stroke="#ccc" strokeWidth="1" />

        {/* Previous close reference line for 1D view */}
        {visibleDays <= 1 && previousClose && minPrice && maxPrice && priceRange > 0 && (
          <g>
            <line
              x1="50"
              y1={260 - ((previousClose - minPrice) / priceRange) * 240}
              x2="770"
              y2={260 - ((previousClose - minPrice) / priceRange) * 240}
              stroke="#333"
              strokeWidth="1"
              strokeDasharray="8 6"
            />
          </g>
        )}

        {chartType === 'line' ? (
          <>
            {areaPath && <path d={areaPath} fill="url(#grad)" />}
            {linePath && <path d={linePath} fill="none" stroke={chartColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
          </>
        ) : (
          <g>
            {candles.map((candle, i) => (
              <g key={i}>
                <line
                  x1={candle.x}
                  y1={candle.wickTop}
                  x2={candle.x}
                  y2={candle.wickBottom}
                  stroke={candle.isGreen ? '#137333' : '#a50e0e'}
                  strokeWidth="1"
                />
                <rect
                  x={candle.x - candle.width / 2}
                  y={candle.bodyTop}
                  width={candle.width}
                  height={candle.bodyHeight}
                  fill={candle.isGreen ? '#137333' : '#a50e0e'}
                />
              </g>
            ))}
          </g>
        )}

        {dragStart && (
          <line
            x1={dragStart.dataX}
            y1="20"
            x2={dragStart.dataX}
            y2="260"
            stroke="#666"
            strokeWidth="1"
            strokeDasharray="4"
            pointerEvents="none"
          />
        )}

        {hoverData && (
          <g pointerEvents="none">
            <line x1={hoverData.dataX} y1="20" x2={hoverData.dataX} y2="260" stroke="#666" strokeWidth="1" strokeDasharray="4" />
            <line x1="50" y1={hoverData.y} x2="770" y2={hoverData.y} stroke="#666" strokeWidth="1" strokeDasharray="4" />
            <circle cx={hoverData.dataX} cy={hoverData.y} r="3.5" fill={chartColor} stroke="#fff" strokeWidth="2" />
          </g>
        )}

      </svg>

      {/* Previous close price label (HTML to avoid SVG text squashing) */}
      {visibleDays <= 1 && previousClose && minPrice && maxPrice && priceRange > 0 && (
        <span
          style={{
            position: 'absolute',
            right: '12px',
            top: `${((260 - ((previousClose - minPrice) / priceRange) * 240) / 300) * 100}%`,
            fontSize: '11px',
            fontFamily: 'IBM Plex Mono',
            color: '#333',
            pointerEvents: 'none',
            whiteSpace: 'nowrap'
          }}
        >
          ${previousClose.toFixed(2)}
        </span>
      )}

      {/* X-axis labels */}
      {xLabels.map((item, idx) => (
        <span
          key={idx}
          style={{
            position: 'absolute',
            left: `${(item.x / 800) * 100}%`,
            bottom: '4%',
            transform: 'translateX(-50%)',
            fontSize: '11px',
            color: '#80868b',
            fontFamily: 'IBM Plex Mono',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            display: 'inline-block'
          }}
        >
          {item.label}
        </span>
      ))}

      {hoverData && (
        <div style={{
          position: 'absolute',
          left: `${(hoverData.dataX / 800) * 100}%`,
          top: `${(hoverData.y / 300) * 100}%`,
          transform: hoverData.dataX < 400 ? 'translate(10px, -50%)' : 'translate(-130px, -50%)',
          pointerEvents: 'none',
          zIndex: 10
        }}>
          <div style={{ background: 'rgba(255, 255, 255, 0.75)', padding: '8px 12px', borderRadius: '4px', minWidth: '80px', textAlign: 'center', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)' }}>
            {dragStart ? (
              (() => {
                const startPrice = dragStart.data.close;
                const currentPrice = hoverData.data.close;
                const absReturn = currentPrice - startPrice;
                const pctReturn = (absReturn / startPrice) * 100;
                const isPositive = absReturn >= 0;
                const color = isPositive ? '#137333' : '#a50e0e';
                const sign = isPositive ? '+' : '';
                const startDate = dayjs(dragStart.data.date).tz(EST).format('D MMM YYYY');
                const endDate = dayjs(hoverData.data.date).tz(EST).format('D MMM YYYY');

                return (
                  <div style={{ fontSize: '12px', fontWeight: 500, fontFamily: '"Google Sans", "Product Sans", "Inter", system-ui, sans-serif', whiteSpace: 'nowrap' }}>
                    <span style={{ color }}>{sign}${absReturn.toFixed(2)} ({sign}{pctReturn.toFixed(2)}%)</span> <span style={{ color: '#666' }}>{startDate}-{endDate}</span>
                  </div>
                );
              })()
            ) : (
              <div style={{ fontSize: '12px', fontWeight: 500, fontFamily: '"Google Sans", "Product Sans", "Inter", system-ui, sans-serif', whiteSpace: 'nowrap' }}>
                <span style={{ color: '#000' }}>${hoverData.data.close.toFixed(2)}</span> <span style={{ color: '#666' }}>{(() => {
                  if (visibleDays <= 1) return dayjs(hoverData.data.date).tz(EST).format('HH:mm');
                  const firstYear = visibleData[0] ? dayjs(visibleData[0].date).tz(EST).year() : null;
                  const lastYear = visibleData[visibleData.length - 1] ? dayjs(visibleData[visibleData.length - 1].date).tz(EST).year() : null;
                  const multiYear = firstYear !== lastYear;
                  return dayjs(hoverData.data.date).tz(EST).format(multiYear ? 'D MMM YYYY' : 'D MMM');
                })()}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
