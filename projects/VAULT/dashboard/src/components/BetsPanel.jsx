import React from 'react';

function formatCost(n) {
  if (n == null) return '$0.00';
  return n < 0.01 && n > -0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function formatPct(n) {
  if (n == null) return '?';
  return `${(n * 100).toFixed(0)}%`;
}

export default function BetsPanel({ positions, predictions }) {
  const openPos = positions?.open || [];
  const closedPos = positions?.closed || [];
  const openPreds = predictions?.open || [];
  const closedPreds = predictions?.closed || [];

  const hasOpen = openPos.length > 0 || openPreds.length > 0;
  const hasClosed = closedPos.length > 0 || closedPreds.length > 0;
  const hasData = hasOpen || hasClosed;

  return (
    <div className="card">
      <div className="card-title">Positions</div>

      {!hasData && <div className="empty">No bets yet</div>}

      {hasOpen && (
        <>
          <div style={{ fontSize: '11px', color: 'var(--alive)', fontWeight: 600, marginBottom: '8px', letterSpacing: '1px' }}>
            OPEN ({openPos.length + openPreds.length})
          </div>

          {openPreds.map((p) => (
            <div key={`pred-${p.id}`} className="position-item">
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
            CLOSED ({closedPos.length + closedPreds.length})
          </div>

          {closedPreds.map((p) => (
            <div key={`pred-${p.id}`} className="position-item">
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
    </div>
  );
}
