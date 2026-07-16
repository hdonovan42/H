import { useState, useRef, useMemo, useCallback } from 'react';
import { dayjs } from '../utils/marketState';
import weekOfYear from 'dayjs/plugin/weekOfYear';

dayjs.extend(weekOfYear);

const MODES = [
  { key: 'swap', label: 'Swap rate' },
  { key: 'ratio', label: 'Ratio' },
  { key: 'indexed', label: 'Indexed' },
];

// Multi-series line chart for the compare page. Same geometry as StockChart
// (viewBox 800x300, plot x 50-770, y 20-260, axis at y 280) but plots N series
// on one shared y-domain — ratio/indexed values are unitless so this is natural.
export default function CompareChart({ series, axisDates, mode, onModeChange, range, ranges, onRangeChange, formatValue }) {
  const svgRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);

  const axisCount = axisDates.length;
  const calcX = useCallback((i) => 50 + (i / (axisCount - 1 || 1)) * 720, [axisCount]);

  const { yLabels, paths, calcY } = useMemo(() => {
    const empty = { yLabels: [], paths: [], calcY: () => 0 };
    const allValues = series.flatMap(s => s.points.map(p => p.value));
    if (allValues.length < 2) return empty;

    let min = Math.min(...allValues);
    let max = Math.max(...allValues);

    // 4 y-axis labels: round bottom near min, round top near max, 2 between —
    // StockChart's scheme with sub-1 steps added for ratio values
    const rawRange = (max - min) || 1;
    const roundTo = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].find(s => s >= rawRange / 30) || 1;
    const bottom = Math.ceil(min / roundTo) * roundTo;
    const top = Math.floor(max / roundTo) * roundTo;
    let labelValues;
    if (top > bottom) {
      const gap = (top - bottom) / 3;
      const mid1 = bottom + Math.round(gap / roundTo) * roundTo;
      const mid2 = bottom + Math.round(gap * 2 / roundTo) * roundTo;
      labelValues = [bottom, mid1, mid2, top];
    } else {
      labelValues = [min, min + rawRange / 3, min + rawRange * 2 / 3, max];
    }
    min = Math.min(min, bottom) - rawRange * 0.02;
    max = Math.max(max, top) + rawRange * 0.02;
    const domain = (max - min) || 1;
    const y = (v) => 260 - ((v - min) / domain) * 240;

    const seriesPaths = series.map(s => ({
      symbol: s.symbol,
      color: s.color,
      d: s.points.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${calcX(p.i)} ${y(p.value)}`).join(' ')
    }));

    return {
      yLabels: labelValues.map(v => ({ label: formatValue(v), y: y(v) })),
      paths: seriesPaths,
      calcY: y
    };
  }, [series, calcX, formatValue]);

  // Per-series axis-index → value lookup for hover
  const valueAt = useMemo(
    () => series.map(s => ({ ...s, byIndex: new Map(s.points.map(p => [p.i, p.value])) })),
    [series]
  );

  const xLabels = useMemo(() => {
    if (!axisCount) return [];
    const labels = [];
    if (range === '3M') {
      const seen = new Set();
      axisDates.forEach((d, i) => {
        const dt = dayjs(d);
        const key = `${dt.year()}-W${dt.week()}`;
        if (seen.has(key)) return;
        seen.add(key);
        labels.push({ label: dt.format('MMM D'), x: calcX(i) });
      });
      if (labels.length > 6) {
        const step = Math.ceil(labels.length / 6);
        return labels.filter((_, i) => i % step === 0);
      }
    } else if (range === '5Y') {
      const seen = new Set();
      axisDates.forEach((d, i) => {
        const year = dayjs(d).year();
        if (seen.has(year)) return;
        seen.add(year);
        labels.push({ label: String(year).slice(-2), x: calcX(i) });
      });
    } else {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const seen = new Set();
      axisDates.forEach((d, i) => {
        const dt = dayjs(d);
        const key = `${dt.year()}-${dt.month()}`;
        if (seen.has(key)) return;
        seen.add(key);
        labels.push({ label: months[dt.month()], x: calcX(i) });
      });
    }
    return labels;
  }, [axisDates, axisCount, range, calcX]);

  const handleMouseMove = useCallback((e) => {
    if (!axisCount || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mouseX = Math.max(50, Math.min(770, (e.clientX - rect.left) * (800 / rect.width)));
    const index = Math.min(Math.max(0, Math.round(((mouseX - 50) / 720) * (axisCount - 1))), axisCount - 1);
    setHoverIndex(index);
  }, [axisCount]);

  return (
    <div className="box compare-chart-box">
      <div className="compare-controls">
        <div className="compare-mode-group">
          {MODES.map((m, idx, arr) => (
            <span key={m.key}>
              <button
                className={`timeframe-btn ${mode === m.key ? 'active' : ''}`}
                onClick={() => onModeChange(m.key)}
              >
                {m.label}
              </button>
              {idx < arr.length - 1 && <span className="timeframe-pipe">|</span>}
            </span>
          ))}
        </div>
        <div className="compare-range-group">
          {ranges.map((r, idx, arr) => (
            <span key={r}>
              <button
                className={`timeframe-btn ${range === r ? 'active' : ''}`}
                onClick={() => onRangeChange(r)}
              >
                {r}
              </button>
              {idx < arr.length - 1 && <span className="timeframe-pipe">|</span>}
            </span>
          ))}
        </div>
      </div>

      <div className="compare-legend">
        {series.map(s => {
          const first = s.points[0]?.value;
          const last = s.points[s.points.length - 1]?.value;
          const change = first && last != null ? ((last / first) - 1) * 100 : null;
          return (
            <span key={s.symbol} className="legend-item">
              <span className="chip-swatch" style={{ background: s.color }} />
              <span>{s.symbol}</span>
              <span className="legend-value">{last != null ? formatValue(last) : '—'}</span>
              {change != null && (
                <span className={`legend-change ${change >= 0 ? 'positive' : 'negative'}`}>
                  {change >= 0 ? '+' : ''}{change.toFixed(1)}%
                </span>
              )}
            </span>
          );
        })}
      </div>

      <div style={{ position: 'relative', width: '100%', aspectRatio: '800 / 300' }}>
        <svg
          ref={svgRef}
          viewBox="0 0 800 300"
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%', cursor: 'crosshair' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          {/* X-axis line */}
          <line x1="50" y1="280" x2="770" y2="280" stroke="#ccc" strokeWidth="1" />

          {paths.map(p => (
            <path key={p.symbol} d={p.d} fill="none" stroke={p.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          ))}

          {hoverIndex != null && (
            <g pointerEvents="none">
              <line x1={calcX(hoverIndex)} y1="20" x2={calcX(hoverIndex)} y2="260" stroke="#666" strokeWidth="1" strokeDasharray="4" />
              {valueAt.map(s => {
                const v = s.byIndex.get(hoverIndex);
                return v != null
                  ? <circle key={s.symbol} cx={calcX(hoverIndex)} cy={calcY(v)} r="3.5" fill={s.color} stroke="#fff" strokeWidth="2" />
                  : null;
              })}
            </g>
          )}

          {/* Nested SVG for text — preserves aspect ratio so text isn't squashed */}
          <svg viewBox="0 0 800 300" preserveAspectRatio="xMidYMid meet">
            {yLabels.map((item, idx) => (
              <text key={idx} x="8" y={item.y} dominantBaseline="central" fill="#80868b" fontSize="11" fontFamily="IBM Plex Mono" pointerEvents="none">{item.label}</text>
            ))}
            {xLabels.map((item, idx) => (
              <text key={idx} x={item.x} y="295" textAnchor="middle" fill="#80868b" fontSize="11" fontFamily="IBM Plex Mono" pointerEvents="none">{item.label}</text>
            ))}
          </svg>
        </svg>

        {/* Hover tooltip — HTML for rich styling */}
        {hoverIndex != null && axisDates[hoverIndex] && (
          <div style={{
            position: 'absolute',
            left: `${(calcX(hoverIndex) / 800) * 100}%`,
            top: '12%',
            transform: calcX(hoverIndex) < 400 ? 'translateX(12px)' : 'translateX(calc(-100% - 12px))',
            pointerEvents: 'none',
            zIndex: 10
          }}>
            <div style={{ background: 'rgba(255, 255, 255, 0.85)', padding: '8px 12px', borderRadius: '4px', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)', fontSize: '12px', whiteSpace: 'nowrap' }}>
              <div style={{ color: '#666', marginBottom: '4px' }}>{dayjs(axisDates[hoverIndex]).format('D MMM YYYY')}</div>
              {valueAt.map(s => {
                const v = s.byIndex.get(hoverIndex);
                return (
                  <div key={s.symbol} style={{ display: 'flex', justifyContent: 'space-between', gap: '14px' }}>
                    <span style={{ color: s.color, fontWeight: 600 }}>{s.symbol}</span>
                    <span>{v != null ? formatValue(v) : '—'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
