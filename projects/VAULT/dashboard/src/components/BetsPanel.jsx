import React, { useState } from 'react';

function formatCost(n) {
  if (n == null) return '$0.00';
  return n < 0.01 && n > -0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function formatPct(n) {
  if (n == null) return '?';
  return `${(n * 100).toFixed(2)}%`;
}

const SOURCE_STYLES = {
  pipeline: { label: 'INTEL', color: '#f5a623', bg: '#f5a62318', border: '#f5a62340' },
  momentum: { label: 'MOMENTUM', color: '#4488ff', bg: '#4488ff18', border: '#4488ff40' },
  legacy: { label: 'LEGACY', color: '#666', bg: '#66666618', border: '#66666640' },
};

function SourceTag({ source }) {
  const s = SOURCE_STYLES[source] || SOURCE_STYLES.pipeline;
  return (
    <span style={{
      fontSize: '9px', fontWeight: 700, letterSpacing: '0.5px',
      padding: '1px 5px', borderRadius: '3px', marginRight: '6px',
      background: s.bg, border: `1px solid ${s.border}`, color: s.color,
    }}>
      {s.label}
    </span>
  );
}

function SourceSummary({ bySource, intelDisabled }) {
  if (!bySource || Object.keys(bySource).length === 0) return null;
  const sources = Object.entries(bySource);
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${sources.length}, 1fr)`,
      gap: '10px', marginBottom: '12px', paddingBottom: '10px',
      borderBottom: '1px solid var(--border)',
    }}>
      {sources.map(([key, s]) => {
        const style = SOURCE_STYLES[key] || SOURCE_STYLES.pipeline;
        const total = s.unrealized + s.realized;
        const paused = key === 'pipeline' && intelDisabled;
        return (
          <div key={key} style={{
            padding: '8px 10px', borderRadius: '6px',
            background: style.bg, border: `1px solid ${style.border}`,
            opacity: paused ? 0.5 : 1,
          }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: style.color, letterSpacing: '0.5px', marginBottom: '4px' }}>
              {style.label}
              {paused && <span style={{ marginLeft: '6px', fontSize: '9px', color: '#ff6b6b', fontWeight: 700 }}>PAUSED</span>}
            </div>
            <div style={{ fontSize: '16px', fontWeight: 600, color: total >= 0 ? '#44ff88' : '#ff4444' }}>
              {total >= 0 ? '+' : ''}{formatCost(total)}
              {s.total_cost > 0 && <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--text-dim)', marginLeft: '6px' }}>
                ({((total / s.total_cost) * 100).toFixed(0)}%)
              </span>}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>
              {s.open > 0 && <span>{s.open} open (${s.cost.toFixed(2)} deployed)</span>}
              {s.open > 0 && (s.won > 0 || s.lost > 0) && ' | '}
              {(s.won > 0 || s.lost > 0) && <span>{s.won}W/{s.lost}L</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function BetsPanel({ positions, predictions }) {
  const [legacyOpen, setLegacyOpen] = useState(false);

  const openPos = positions?.open || [];
  const closedPos = positions?.closed || [];
  const openPreds = predictions?.open || [];
  const closedPreds = predictions?.closed || [];
  const bySource = predictions?.by_source;

  // Split into legacy vs current
  const currentOpenPreds = openPreds.filter((p) => p.source !== 'legacy');
  const legacyOpenPreds = openPreds.filter((p) => p.source === 'legacy');
  const currentClosedPreds = closedPreds.filter((p) => p.source !== 'legacy');
  const legacyClosedPreds = closedPreds.filter((p) => p.source === 'legacy');
  const legacyCount = legacyOpenPreds.length + legacyClosedPreds.length;
  const legacyPnl = [...legacyOpenPreds, ...legacyClosedPreds].reduce(
    (sum, p) => sum + (p.unrealized_pnl ?? p.pnl ?? 0), 0,
  );

  const hasOpen = openPos.length > 0 || currentOpenPreds.length > 0;
  const hasClosed = closedPos.length > 0 || currentClosedPreds.length > 0;
  const hasData = hasOpen || hasClosed || legacyCount > 0;

  return (
    <div className="card">
      <div className="card-title">Positions</div>

      <SourceSummary bySource={bySource} intelDisabled={predictions?.intel_disabled} />

      {!hasData && <div className="empty">No bets yet</div>}

      {hasOpen && (
        <>
          <div style={{ fontSize: '11px', color: 'var(--alive)', fontWeight: 600, marginBottom: '8px', letterSpacing: '1px' }}>
            OPEN ({openPos.length + currentOpenPreds.length})
          </div>

          {currentOpenPreds.map((p) => (
            <div key={`pred-${p.id}`} className="position-item">
              <div className="position-header">
                <span>
                  <SourceTag source={p.source} />
                  <span className={`prediction-side ${p.side.toLowerCase()}`}>{p.side}</span>
                  {' '}
                  <span className="prediction-question">{p.question}</span>
                </span>
                <span className={p.unrealized_pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                  {p.unrealized_pnl >= 0 ? '+' : ''}{formatCost(p.unrealized_pnl)}
                </span>
              </div>
              <div className="position-detail">
                {p.shares?.toFixed(2)} shares | {formatPct(p.entry_odds)} &rarr; {formatPct(p.current_odds)} | cost {formatCost(p.cost_basis)} &rarr; mkt {formatCost(p.market_value)}
                {p.end_date && ` | exp ${p.end_date.slice(0, 10)}`}
              </div>
            </div>
          ))}

          {openPos.map((p) => (
            <div key={`pos-${p.id}`} className="position-item">
              <div className="position-header">
                <span className="position-asset">{p.asset}</span>
                <span className={p.unrealized_pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                  {p.unrealized_pnl >= 0 ? '+' : ''}{formatCost(p.unrealized_pnl)}
                </span>
              </div>
              <div className="position-detail">
                {p.quantity.toFixed(8)} units | cost: {formatCost(p.cost_basis)} &rarr; mkt: {formatCost(p.market_value)}
                {p.current_price != null && ` @ $${p.current_price.toLocaleString()}`}
              </div>
            </div>
          ))}
        </>
      )}

      {hasClosed && (
        <>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: 600, marginTop: hasOpen ? '16px' : 0, marginBottom: '8px', letterSpacing: '1px' }}>
            CLOSED ({closedPos.length + currentClosedPreds.length})
          </div>

          {currentClosedPreds.map((p) => (
            <div key={`pred-${p.id}`} className="position-item">
              <div className="position-header">
                <span>
                  <SourceTag source={p.source} />
                  <span className={`prediction-side ${p.side.toLowerCase()}`}>{p.side}</span>
                  {' '}
                  <span className={`prediction-resolution ${p.resolution}`}>{p.resolution?.toUpperCase()}</span>
                  {' '}
                  <span className="prediction-question">{p.question}</span>
                </span>
                <span className={p.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                  {p.pnl >= 0 ? '+' : ''}{formatCost(p.pnl)}
                </span>
              </div>
              <div className="position-detail">
                cost {formatCost(p.cost_basis)} &rarr; payout {formatCost(p.payout)} | {p.closed_at?.slice(0, 10)}
              </div>
            </div>
          ))}

          {closedPos.map((p) => (
            <div key={`pos-${p.id}`} className="position-item">
              <div className="position-header">
                <span className="position-asset">{p.asset}</span>
                <span className={p.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                  {p.pnl >= 0 ? '+' : ''}{formatCost(p.pnl)}
                </span>
              </div>
              <div className="position-detail">
                {p.quantity.toFixed(8)} units | {formatCost(p.cost_basis)} &rarr; {formatCost(p.close_price * p.quantity)} | {p.closed_at?.slice(0, 10)}
              </div>
            </div>
          ))}
        </>
      )}

      {legacyCount > 0 && (
        <div style={{ marginTop: '16px', borderTop: '1px solid var(--border)' }}>
          <div
            onClick={() => setLegacyOpen(!legacyOpen)}
            style={{
              fontSize: '11px', color: '#666', fontWeight: 600, letterSpacing: '1px',
              padding: '10px 0 4px', cursor: 'pointer', userSelect: 'none',
            }}
          >
            {legacyOpen ? '\u25BC' : '\u25B6'} LEGACY ({legacyCount})
            <span style={{ fontWeight: 400, marginLeft: '8px', color: legacyPnl >= 0 ? '#44ff88' : '#ff4444' }}>
              {legacyPnl >= 0 ? '+' : ''}{formatCost(legacyPnl)}
            </span>
          </div>

          {legacyOpen && (
            <>
              {legacyOpenPreds.map((p) => (
                <div key={`pred-${p.id}`} className="position-item">
                  <div className="position-header">
                    <span>
                      <SourceTag source="legacy" />
                      <span className={`prediction-side ${p.side.toLowerCase()}`}>{p.side}</span>
                      {' '}
                      <span className="prediction-question">{p.question}</span>
                    </span>
                    <span className={p.unrealized_pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                      {p.unrealized_pnl >= 0 ? '+' : ''}{formatCost(p.unrealized_pnl)}
                    </span>
                  </div>
                  <div className="position-detail">
                    {p.shares?.toFixed(2)} shares | {formatPct(p.entry_odds)} &rarr; {formatPct(p.current_odds)} | cost {formatCost(p.cost_basis)} &rarr; mkt {formatCost(p.market_value)}
                  </div>
                </div>
              ))}

              {legacyClosedPreds.map((p) => (
                <div key={`pred-${p.id}`} className="position-item">
                  <div className="position-header">
                    <span>
                      <SourceTag source="legacy" />
                      <span className={`prediction-side ${p.side.toLowerCase()}`}>{p.side}</span>
                      {' '}
                      <span className={`prediction-resolution ${p.resolution}`}>{p.resolution?.toUpperCase()}</span>
                      {' '}
                      <span className="prediction-question">{p.question}</span>
                    </span>
                    <span className={p.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                      {p.pnl >= 0 ? '+' : ''}{formatCost(p.pnl)}
                    </span>
                  </div>
                  <div className="position-detail">
                    cost {formatCost(p.cost_basis)} &rarr; payout {formatCost(p.payout)} | {p.closed_at?.slice(0, 10)}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
