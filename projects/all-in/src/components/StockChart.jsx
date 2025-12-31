import { useState, useRef, useMemo, useCallback } from 'react';
import { dayjs } from '../utils/marketState';
import { EST } from '../utils/config';

export default function StockChart({ chartData, timeframe, onTimeframeChange, previousClose }) {
  const svgRef = useRef(null);
  const [hoverData, setHoverData] = useState(null);

  const { minPrice, maxPrice, priceRange, linePath, areaPath } = useMemo(() => {
    if (!chartData?.length) return { minPrice: 0, maxPrice: 100, priceRange: 100, linePath: '', areaPath: '' };

    const min = Math.min(...chartData.map(d => d.low)) * 0.999;
    const max = Math.max(...chartData.map(d => d.high)) * 1.001;
    const range = (max - min) || 1;
    const calcY = (price) => 260 - ((price - min) / range) * 240;

    const calcX = (d, i) => {
      if (timeframe === '1D') {
        const estTime = dayjs(d.date).tz(EST);
        const timeInHours = Math.max(9.5, Math.min(16, estTime.hour() + estTime.minute() / 60));
        return 50 + ((timeInHours - 9.5) / 6.5) * 720;
      }
      return 50 + (i / (chartData.length - 1 || 1)) * 720;
    };

    const line = chartData.length > 1 ? chartData.map((d, i) => `${i === 0 ? 'M' : 'L'} ${calcX(d, i)} ${calcY(d.close)}`).join(' ') : '';
    const area = line ? `${line} L ${calcX(chartData[chartData.length - 1], chartData.length - 1)} 260 L ${calcX(chartData[0], 0)} 260 Z` : '';

    return { minPrice: min, maxPrice: max, priceRange: range, linePath: line, areaPath: area };
  }, [chartData, timeframe]);

  let isChartPositive = true;
  if (timeframe === '1D') {
    const baseline = previousClose || chartData[0]?.close || 0;
    isChartPositive = (chartData[chartData.length - 1]?.close || 0) >= baseline;
  } else if (chartData.length > 0) {
    isChartPositive = chartData[chartData.length - 1].close >= chartData[0].close;
  }
  const chartColor = isChartPositive ? '#137333' : '#a50e0e';

  const handleMouseMove = useCallback((e) => {
    if (!chartData?.length || !svgRef.current) return;

    const svgRect = svgRef.current.getBoundingClientRect();
    const scaleX = 800 / svgRect.width;
    let mouseX = Math.max(50, Math.min(770, (e.clientX - svgRect.left) * scaleX));

    let index, dataX;

    if (timeframe === '1D') {
      const mouseTimeHours = 9.5 + ((mouseX - 50) / 720) * 6.5;
      let nearestIndex = 0, nearestDiff = Infinity;

      chartData.forEach((d, i) => {
        const estTime = dayjs(d.date).tz(EST);
        const timeInHours = estTime.hour() + estTime.minute() / 60;
        const diff = Math.abs(timeInHours - mouseTimeHours);
        if (diff < nearestDiff) { nearestDiff = diff; nearestIndex = i; }
      });

      index = nearestIndex;
      const point = chartData[index];
      const estTime = dayjs(point.date).tz(EST);
      const timeInHours = Math.max(9.5, Math.min(16, estTime.hour() + estTime.minute() / 60));
      dataX = 50 + ((timeInHours - 9.5) / 6.5) * 720;
    } else {
      const ratio = (mouseX - 50) / 720;
      index = Math.round(ratio * (chartData.length - 1));
      dataX = 50 + (index / (chartData.length - 1)) * 720;
    }

    if (index >= 0 && index < chartData.length) {
      const point = chartData[index];
      const yPos = 260 - ((point.close - minPrice) / priceRange) * 240;
      setHoverData({ dataX, y: yPos, data: point });
    }
  }, [chartData, timeframe, minPrice, priceRange]);

  const renderYAxisLabels = () => {
    const min = Math.floor(minPrice / 20) * 20;
    const max = Math.ceil(maxPrice / 20) * 20;
    const step = Math.ceil((max - min) / 5 / 20) * 20;
    const steps = [];
    for (let p = max; p >= min && steps.length < 6; p -= step) steps.push(p);
    return steps.map(p => (
      <text key={p} x="8" y={20 + ((max - p) / ((max - min) || 1)) * 240 + 4} fontSize="11" fill="#80868b" fontFamily="IBM Plex Mono">
        ${p}
      </text>
    ));
  };

  const renderXAxisLabels = () => {
    if (!chartData.length) return null;

    const maxLabels = {
      '1D': 7, '1W': 6, '1M': 3, '3M': 3, '6M': 6, 'YTD': 12, '1Y': 12, '5Y': 5
    };

    const limit = maxLabels[timeframe] || 6;

    const spacedLabels = (labels) => {
      if (labels.length <= limit) return labels;
      return labels.slice(labels.length - limit);
    };

    let allLabels = [];

    if (timeframe === '1D') {
      allLabels = ['10:00','11:00','12:00','13:00','14:00','15:00','16:00'].map((label, idx) => ({
        label,
        x: 50 + ((0.5 + idx) / 6.5) * 720
      }));
    } else if (timeframe === '1W') {
      const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const seen = new Set();
      chartData.forEach((d, i) => {
        const date = dayjs(d.date).format('YYYY-MM-DD');
        if (seen.has(date)) return;
        seen.add(date);
        allLabels.push({
          label: days[dayjs(d.date).day()],
          x: 50 + (i / (chartData.length - 1 || 1)) * 720
        });
      });
    } else if (timeframe === '5Y') {
      const seen = new Set();
      chartData.forEach((d, i) => {
        const year = dayjs(d.date).year();
        if (seen.has(year)) return;
        seen.add(year);
        allLabels.push({
          label: String(year).slice(-2),
          x: 50 + (i / (chartData.length - 1 || 1)) * 720
        });
      });
    } else {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const seen = new Set();
      chartData.forEach((d, i) => {
        const dt = dayjs(d.date);
        const key = `${dt.year()}-${dt.month()}`;
        if (seen.has(key)) return;
        seen.add(key);
        allLabels.push({
          label: months[dt.month()],
          x: 50 + (i / (chartData.length - 1 || 1)) * 720
        });
      });
    }

    const finalLabels = spacedLabels(allLabels);

    return (
      <g>
        {finalLabels.map((item, idx) => (
          <text key={idx} x={item.x} y="290" textAnchor="middle" fontSize="11" fill="#80868b" fontFamily="IBM Plex Mono">
            {item.label}
          </text>
        ))}
      </g>
    );
  };

  return (
    <div className="box chart-box">
      <div className="timeframe-controls">
        {['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', '5Y'].map((tf, idx, arr) => (
          <span key={tf}>
            <button className={`timeframe-btn ${timeframe === tf ? 'active' : ''}`} onClick={() => onTimeframeChange(tf)}>
              {tf}
            </button>
            {idx < arr.length - 1 && <span className="timeframe-pipe">|</span>}
          </span>
        ))}
      </div>

      <svg
        ref={svgRef}
        viewBox="0 0 800 300"
        preserveAspectRatio="none"
        style={{ width: '100%', height: '100%', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverData(null)}
      >
        <defs>
          <linearGradient id="grad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={isChartPositive ? 'rgba(19,115,51,0.2)' : 'rgba(165,14,14,0.2)'} />
            <stop offset="100%" stopColor={isChartPositive ? 'rgba(19,115,51,0)' : 'rgba(165,14,14,0)'} />
          </linearGradient>
        </defs>

        {renderYAxisLabels()}

        {areaPath && <path d={areaPath} fill="url(#grad)" />}
        {linePath && <path d={linePath} fill="none" stroke={chartColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}

        {renderXAxisLabels()}

        {hoverData && (
          <g pointerEvents="none">
            <line x1={hoverData.dataX} y1="20" x2={hoverData.dataX} y2="260" stroke="#666" strokeWidth="1" strokeDasharray="4" />
            <line x1="50" y1={hoverData.y} x2="770" y2={hoverData.y} stroke="#666" strokeWidth="1" strokeDasharray="4" />
            <circle cx={hoverData.dataX} cy={hoverData.y} r="3.5" fill={chartColor} stroke="#fff" strokeWidth="2" />
          </g>
        )}
      </svg>

      {hoverData && (
        <div style={{
          position: 'absolute',
          left: `${(hoverData.dataX / 800) * 100}%`,
          top: `${(hoverData.y / 300) * 100}%`,
          transform: hoverData.dataX < 400 ? 'translate(10px, -50%)' : 'translate(-130px, -50%)',
          pointerEvents: 'none',
          zIndex: 10
        }}>
          <div style={{ background: 'rgba(26, 26, 26, 0.9)', padding: '8px 12px', borderRadius: '4px', minWidth: '80px', textAlign: 'center' }}>
            <div style={{ color: '#fff', fontSize: '13px', fontWeight: 600, fontFamily: 'IBM Plex Mono', marginBottom: '4px' }}>
              ${hoverData.data.close.toFixed(2)}
            </div>
            <div style={{ color: '#ccc', fontSize: '10px', fontFamily: 'IBM Plex Mono' }}>
              {timeframe === '1D'
                ? dayjs(hoverData.data.date).tz(EST).format('HH:mm')
                : dayjs(hoverData.data.date).tz(EST).format('MMM D')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
