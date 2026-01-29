import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { dayjs } from '../../utils/marketState';
import { EST } from '../../utils/config';

const POST_MARKET_START = 16;
const POST_MARKET_END = 20;
const DURATION = 4;

const PADDING = { top: 20, right: 70, bottom: 40, left: 10 };

export default function FullscreenChart({ data, closePrice }) {
  const containerRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoverData, setHoverData] = useState(null);

  // Measure container
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.round(width), h: Math.round(height) });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const chartW = size.w - PADDING.left - PADDING.right;
  const chartH = size.h - PADDING.top - PADDING.bottom;

  // Filter to post-market
  const pmData = useMemo(() => {
    if (!data?.length) return [];
    return data.filter(d => {
      const hour = dayjs(d.date).tz(EST).hour();
      return hour >= POST_MARKET_START && hour < POST_MARKET_END;
    });
  }, [data]);

  // Price range
  const { min, max, range } = useMemo(() => {
    if (!pmData.length) return { min: 0, max: 1, range: 1 };
    const prices = [...pmData.map(d => d.close), closePrice].filter(p => p != null && isFinite(p));
    const mn = Math.min(...prices) * 0.999;
    const mx = Math.max(...prices) * 1.001;
    return { min: mn, max: mx, range: (mx - mn) || 1 };
  }, [pmData, closePrice]);

  const calcX = useCallback((d) => {
    const t = dayjs(d.date).tz(EST);
    const h = Math.max(POST_MARKET_START, Math.min(POST_MARKET_END, t.hour() + t.minute() / 60));
    return PADDING.left + ((h - POST_MARKET_START) / DURATION) * chartW;
  }, [chartW]);

  const calcY = useCallback((price) => {
    return PADDING.top + chartH - ((price - min) / range) * chartH;
  }, [chartH, min, range]);

  // Build paths
  const { linePath, areaPath } = useMemo(() => {
    const valid = pmData.filter(d => d.close != null && isFinite(d.close));
    if (valid.length < 2 || chartW <= 0) return { linePath: '', areaPath: '' };

    const pts = valid.map(d => ({ x: calcX(d), y: calcY(d.close) }));
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    const baseY = PADDING.top + chartH;
    const area = `${line} L${pts[pts.length - 1].x},${baseY} L${pts[0].x},${baseY} Z`;
    return { linePath: line, areaPath: area };
  }, [pmData, chartW, calcX, calcY, chartH]);

  const isPositive = useMemo(() => {
    if (!pmData.length || closePrice == null) return true;
    return pmData[pmData.length - 1]?.close >= closePrice;
  }, [pmData, closePrice]);

  const strokeColor = isPositive ? '#22c55e' : '#ef4444';
  const fillStart = isPositive ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)';

  // Y-axis gridlines
  const yTicks = useMemo(() => {
    if (range <= 0 || chartH <= 0) return [];
    const step = range / 5;
    const ticks = [];
    for (let i = 0; i <= 5; i++) {
      const price = min + step * i;
      ticks.push({ price, y: calcY(price) });
    }
    return ticks;
  }, [min, range, chartH, calcY]);

  // X-axis labels
  const xTicks = useMemo(() => {
    if (chartW <= 0) return [];
    return [16, 17, 18, 19, 20].map(h => ({
      label: `${h}:00`,
      x: PADDING.left + ((h - POST_MARKET_START) / DURATION) * chartW
    }));
  }, [chartW]);

  const closeLineY = closePrice != null ? calcY(closePrice) : null;

  // Hover
  const handleMouseMove = useCallback((e) => {
    if (!pmData.length || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const mouseTime = POST_MARKET_START + ((mx - PADDING.left) / chartW) * DURATION;

    let nearest = 0, bestDiff = Infinity;
    pmData.forEach((d, i) => {
      const t = dayjs(d.date).tz(EST);
      const h = t.hour() + t.minute() / 60;
      const diff = Math.abs(h - mouseTime);
      if (diff < bestDiff) { bestDiff = diff; nearest = i; }
    });

    const pt = pmData[nearest];
    if (!pt?.close) return;
    setHoverData({
      x: calcX(pt),
      y: calcY(pt.close),
      price: pt.close,
      time: dayjs(pt.date).tz(EST).format('HH:mm'),
      change: pt.close - closePrice,
      changePct: ((pt.close - closePrice) / closePrice) * 100
    });
  }, [pmData, chartW, calcX, calcY, closePrice]);

  if (!pmData.length || size.w === 0) {
    return <div ref={containerRef} style={{ width: '100%', flex: 1, minHeight: 0 }} />;
  }

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', flex: 1, minHeight: 0, position: 'relative' }}
    >
      <svg
        width={size.w}
        height={size.h}
        style={{ display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverData(null)}
      >
        <defs>
          <linearGradient id="fsGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={fillStart} />
            <stop offset="100%" stopColor="transparent" />
          </linearGradient>
        </defs>

        {/* Horizontal gridlines + Y labels */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={PADDING.left} y1={t.y}
              x2={size.w - PADDING.right} y2={t.y}
              stroke="#222" strokeWidth="1"
            />
            <text
              x={size.w - PADDING.right + 8} y={t.y + 4}
              fill="#666" fontSize="12" fontFamily="monospace"
            >
              ${t.price.toFixed(2)}
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {xTicks.map((t, i) => (
          <text
            key={i} x={t.x} y={size.h - 10}
            fill="#555" fontSize="12" textAnchor="middle" fontFamily="monospace"
          >
            {t.label}
          </text>
        ))}

        {/* Close price dashed line */}
        {closeLineY != null && (
          <>
            <line
              x1={PADDING.left} y1={closeLineY}
              x2={size.w - PADDING.right} y2={closeLineY}
              stroke="#555" strokeWidth="1" strokeDasharray="6,4"
            />
            <text
              x={size.w - PADDING.right + 8} y={closeLineY + 4}
              fill="#888" fontSize="12" fontFamily="monospace" fontWeight="bold"
            >
              Close
            </text>
          </>
        )}

        {/* Area fill + line */}
        {areaPath && <path d={areaPath} fill="url(#fsGrad)" />}
        {linePath && (
          <path
            d={linePath} fill="none"
            stroke={strokeColor} strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round"
          />
        )}

        {/* Hover crosshair */}
        {hoverData && (
          <g pointerEvents="none">
            <line
              x1={hoverData.x} y1={PADDING.top}
              x2={hoverData.x} y2={PADDING.top + chartH}
              stroke="#444" strokeWidth="1" strokeDasharray="4,4"
            />
            <line
              x1={PADDING.left} y1={hoverData.y}
              x2={size.w - PADDING.right} y2={hoverData.y}
              stroke="#444" strokeWidth="1" strokeDasharray="4,4"
            />
            <circle
              cx={hoverData.x} cy={hoverData.y} r="5"
              fill={strokeColor} stroke="#fff" strokeWidth="2"
            />
          </g>
        )}
      </svg>

      {/* Hover tooltip */}
      {hoverData && (
        <div
          style={{
            position: 'absolute',
            left: hoverData.x > size.w / 2
              ? hoverData.x - 160
              : hoverData.x + 16,
            top: Math.max(10, hoverData.y - 30),
            background: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: 4,
            padding: '8px 12px',
            pointerEvents: 'none',
            fontFamily: 'monospace',
            fontSize: 14,
            color: '#ccc',
            whiteSpace: 'nowrap',
            zIndex: 10
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600, color: '#fff' }}>
            ${hoverData.price.toFixed(2)}
          </div>
          <div style={{ color: hoverData.change >= 0 ? '#22c55e' : '#ef4444' }}>
            {hoverData.change >= 0 ? '+' : ''}{hoverData.change.toFixed(2)} ({hoverData.changePct.toFixed(2)}%)
          </div>
          <div style={{ color: '#666', fontSize: 12 }}>{hoverData.time} EST</div>
        </div>
      )}
    </div>
  );
}
