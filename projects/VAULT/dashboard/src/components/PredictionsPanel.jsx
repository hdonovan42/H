import React from 'react';

function formatCost(n) {
  if (n == null) return '$0.00';
  return n < 0.01 && n > -0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function formatPct(n) {
  if (n == null) return '?';
  return `${(n * 100).toFixed(0)}%`;
}

export default function PredictionsPanel({ predictions }) {
  if (!predictions) {
    return (
      <div className="card">
        <div className="card-title">Predictions</div>
        <div className="empty">No predictions data</div>
      </div>
    );
  }

  const { open: openPreds, closed: closedPreds } = predictions;
  const hasData = (openPreds && openPreds.length > 0) || (closedPreds && closedPreds.length > 0);

  return (
    <div className="card">
      <div className="card-title">Predictions</div>

      {!hasData && <div className="empty">No predictions yet</div>}

      {openPreds && openPreds.length > 0 && (
        <>
          <div style={{ fontSize: '11px', color: 'var(--alive)', fontWeight: 600, marginBottom: '8px', letterSpacing: '1px' }}>
            OPEN ({openPreds.length})
          </div>
          {openPreds.map((p) => (
            <div key={p.id} className="position-item">
              <div className="position-header">
                <span>
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
        </>
      )}

      {closedPreds && closedPreds.length > 0 && (
        <>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: 600, marginTop: openPreds?.length > 0 ? '16px' : 0, marginBottom: '8px', letterSpacing: '1px' }}>
            CLOSED ({closedPreds.length})
          </div>
          {closedPreds.map((p) => (
            <div key={p.id} className="position-item">
              <div className="position-header">
                <span>
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
  );
}
