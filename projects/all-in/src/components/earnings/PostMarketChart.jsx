import { useState, useRef, useMemo, useCallback } from 'react';
import { dayjs } from '../../utils/marketState';
import { EST } from '../../utils/config';

const POST_MARKET_START = 16; // 4:00 PM
const POST_MARKET_END = 20;   // 8:00 PM
const DURATION = 4;           // hours

export default function PostMarketChart({ data, closePrice }) {
  const svgRef = useRef(null);
  const [hoverData, setHoverData] = useState(null);

  // Filter data to only post-market hours (4pm-8pm)
  const postMarketData = useMemo(() => {
    if (!data?.length) return [];
    return data.filter(d => {
      const hour = dayjs(d.date).tz(EST).hour();
      return hour >= POST_MARKET_START && hour < POST_MARKET_END;
    });
  }, [data]);

  // Calculate chart paths
  const { minPrice, maxPrice, priceRange, linePath, areaPath } = useMemo(() => {
    if (!postMarketData?.length) return { minPrice: 0, maxPrice: 100, priceRange: 100, linePath: '', areaPath: '' };

    const validData = postMarketData.filter(d =>
      d.close != null && isFinite(d.close)
    );
    if (validData.length < 2) return { minPrice: 0, maxPrice: 100, priceRange: 100, linePath: '', areaPath: '' };

    // Include closePrice in min/max calculation for context
    const allPrices = [...validData.map(d => d.close), closePrice].filter(p => p != null);
    const min = Math.min(...allPrices) * 0.999;
    const max = Math.max(...allPrices) * 1.001;
    const range = (max - min) || 1;

    const calcY = (price) => 130 - ((price - min) / range) * 110;
    const calcX = (d) => {
      const estTime = dayjs(d.date).tz(EST);
      const timeInHours = Math.max(POST_MARKET_START, Math.min(POST_MARKET_END, estTime.hour() + estTime.minute() / 60));
      return 30 + ((timeInHours - POST_MARKET_START) / DURATION) * 240;
    };

    const line = validData.map((d, i) => `${i === 0 ? 'M' : 'L'} ${calcX(d)} ${calcY(d.close)}`).join(' ');
    const area = line
      ? `${line} L ${calcX(validData[validData.length - 1])} 130 L ${calcX(validData[0])} 130 Z`
      : '';

    return { minPrice: min, maxPrice: max, priceRange: range, linePath: line, areaPath: area };
  }, [postMarketData, closePrice]);

  // Determine chart color based on price movement from close
  const isChartPositive = useMemo(() => {
    if (!postMarketData?.length || closePrice == null) return true;
    const lastPrice = postMarketData[postMarketData.length - 1]?.close;
    return lastPrice >= closePrice;
  }, [postMarketData, closePrice]);

  const chartColor = isChartPositive ? '#137333' : '#a50e0e';

  // Mouse move handler
  const handleMouseMove = useCallback((e) => {
    if (!postMarketData?.length || !svgRef.current) return;

    const svgRect = svgRef.current.getBoundingClientRect();
    const scaleX = 300 / svgRect.width;
    const mouseX = Math.max(30, Math.min(270, (e.clientX - svgRect.left) * scaleX));

    // Convert mouse X to time
    const mouseTimeHours = POST_MARKET_START + ((mouseX - 30) / 240) * DURATION;

    // Find nearest data point
    let nearestIndex = 0, nearestDiff = Infinity;
    postMarketData.forEach((d, i) => {
      const estTime = dayjs(d.date).tz(EST);
      const timeInHours = estTime.hour() + estTime.minute() / 60;
      const diff = Math.abs(timeInHours - mouseTimeHours);
      if (diff < nearestDiff) { nearestDiff = diff; nearestIndex = i; }
    });

    const point = postMarketData[nearestIndex];
    if (!point?.close) return;

    const estTime = dayjs(point.date).tz(EST);
    const timeInHours = Math.max(POST_MARKET_START, Math.min(POST_MARKET_END, estTime.hour() + estTime.minute() / 60));
    const dataX = 30 + ((timeInHours - POST_MARKET_START) / DURATION) * 240;
    const yPos = 130 - ((point.close - minPrice) / (priceRange || 1)) * 110;

    setHoverData({ dataX, y: yPos, data: point });
  }, [postMarketData, minPrice, priceRange]);

  // X-axis labels (16:00 to 20:00)
  const xLabels = ['16:00', '17:00', '18:00', '19:00', '20:00'].map((label, idx, arr) => {
    const hour = parseInt(label.split(':')[0]);
    let x = 30 + ((hour - POST_MARKET_START) / DURATION) * 240;
    if (idx === 0) x += 8;
    if (idx === arr.length - 1) x -= 8;
    return { label, x };
  });

  // Close price line Y position
  const closeLineY = closePrice != null && priceRange > 0
    ? 130 - ((closePrice - minPrice) / priceRange) * 110
    : null;

  if (!postMarketData?.length) {
    return (
      <div className="post-market-chart">
        <div className="chart-placeholder">No post-market data</div>
      </div>
    );
  }

  return (
    <div className="post-market-chart">
      <svg
        ref={svgRef}
        viewBox="0 0 300 150"
        preserveAspectRatio="none"
        style={{ width: '100%', height: '100%', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverData(null)}
      >
        <defs>
          <linearGradient id="postMarketGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={isChartPositive ? 'rgba(19,115,51,0.2)' : 'rgba(165,14,14,0.2)'} />
            <stop offset="100%" stopColor={isChartPositive ? 'rgba(19,115,51,0)' : 'rgba(165,14,14,0)'} />
          </linearGradient>
        </defs>

        {/* Close price reference line */}
        {closeLineY != null && (
          <>
            <line x1="30" y1={closeLineY} x2="270" y2={closeLineY} stroke="#555" strokeWidth="1" strokeDasharray="4" />
            <text x="270" y={closeLineY - 4} fill="#555" fontSize="10" textAnchor="end">
              ${closePrice.toFixed(2)}
            </text>
          </>
        )}

        {/* Chart area and line */}
        {areaPath && <path d={areaPath} fill="url(#postMarketGrad)" />}
        {linePath && <path d={linePath} fill="none" stroke={chartColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}

        {/* X-axis line */}
        <line x1="30" y1="140" x2="270" y2="140" stroke="#333" strokeWidth="1" />

        {/* Hover crosshair */}
        {hoverData && (
          <g pointerEvents="none">
            <line x1={hoverData.dataX} y1="10" x2={hoverData.dataX} y2="130" stroke="#666" strokeWidth="1" strokeDasharray="4" />
            <circle cx={hoverData.dataX} cy={hoverData.y} r="3" fill={chartColor} stroke="#fff" strokeWidth="1.5" />
          </g>
        )}
      </svg>

      {/* X-axis labels */}
      {xLabels.map((item, idx) => (
        <span
          key={idx}
          className="chart-x-label"
          style={{ left: `${(item.x / 300) * 100}%` }}
        >
          {item.label}
        </span>
      ))}

      {/* Hover tooltip */}
      {hoverData && (
        <div
          className="chart-tooltip"
          style={{
            left: `${(hoverData.dataX / 300) * 100}%`,
            top: `${(hoverData.y / 150) * 100}%`,
            transform: hoverData.dataX < 150 ? 'translate(8px, -50%)' : 'translate(-108%, -50%)'
          }}
        >
          <span className="tooltip-price">${hoverData.data.close.toFixed(2)}</span>
          <span className="tooltip-time">{dayjs(hoverData.data.date).tz(EST).format('HH:mm')}</span>
        </div>
      )}
    </div>
  );
}
