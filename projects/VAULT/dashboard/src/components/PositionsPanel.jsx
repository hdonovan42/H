import React from 'react';

function formatCost(n) {
  if (n == null) return '$0.00';
  return n < 0.01 && n > -0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export default function PositionsPanel({ positions }) {
  if (!positions) {
    return (
      <div className="card">
        <div className="card-title">Positions & P&L</div>
        <div className="empty">No positions data</div>
      </div>
    );
  }

  const { open: openPos, closed: closedPos } = positions;
  const hasData = (openPos && openPos.length > 0) || (closedPos && closedPos.length > 0);

  return (
    <div className="card">
      <div className="card-title">Positions & P&L</div>

      {!hasData && <div className="empty">No positions yet</div>}

      {openPos && openPos.length > 0 && (
        <>
          <div style={{ fontSize: '11px', color: 'var(--alive)', fontWeight: 600, marginBottom: '8px', letterSpacing: '1px' }}>
            OPEN ({openPos.length})
          </div>
          {openPos.map((p) => (
            <div key={p.id} className="position-item">
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

      {closedPos && closedPos.length > 0 && (
        <>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: 600, marginTop: openPos?.length > 0 ? '16px' : 0, marginBottom: '8px', letterSpacing: '1px' }}>
            CLOSED ({closedPos.length})
          </div>
          {closedPos.map((p) => (
            <div key={p.id} className="position-item">
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
