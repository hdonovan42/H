import React, { useState } from 'react';

function formatCost(n) {
  if (n == null) return '$0.00';
  return `$${n.toFixed(2)}`;
}

function formatPct(n) {
  if (n == null) return '?';
  return `${(n * 100).toFixed(2)}%`;
}

const SOURCE_STYLES = {
  momentum: { label: 'MOMENTUM', color: '#4488ff', bg: '#4488ff18', border: '#4488ff40' },
  legacy: { label: 'LEGACY', color: '#666', bg: '#66666618', border: '#66666640' },
};

function SourceTag({ source }) {
  const s = SOURCE_STYLES[source] || SOURCE_STYLES.legacy;
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

function SourceSummary({ bySource }) {
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
        const style = SOURCE_STYLES[key] || SOURCE_STYLES.legacy;
        const total = s.unrealized + s.realized;
        return (
          <div key={key} style={{
            padding: '8px 10px', borderRadius: '6px',
            background: style.bg, border: `1px solid ${style.border}`,
          }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: style.color, letterSpacing: '0.5px', marginBottom: '4px' }}>
              {style.label}
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
  const [closedOpen, setClosedOpen] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [expandedMarkets, setExpandedMarkets] = useState(new Set());

  function toggleMarket(key) {
    setExpandedMarkets(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

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

  // Group open predictions by market
  const marketGroups = {};
  for (const p of currentOpenPreds) {
    const key = p.question;
    if (!marketGroups[key]) {
      marketGroups[key] = {
        question: p.question,
        side: p.side,
        source: p.source,
        current_odds: p.current_odds,
        end_date: p.end_date,
        positions: [],
        totalShares: 0,
        totalCost: 0,
        totalValue: 0,
        totalPnl: 0,
      };
    }
    const g = marketGroups[key];
    g.positions.push(p);
    g.totalShares += p.shares || 0;
    g.totalCost += p.cost_basis || 0;
    g.totalValue += p.market_value || 0;
    g.totalPnl += p.unrealized_pnl || 0;
  }
  const markets = Object.values(marketGroups);

  const hasOpen = openPos.length > 0 || currentOpenPreds.length > 0;
  const hasClosed = closedPos.length > 0 || currentClosedPreds.length > 0;
  const hasData = hasOpen || hasClosed || legacyCount > 0;

  return (
    <div>
      <SourceSummary bySource={bySource} />

      {!hasData && <div className="empty">No bets yet</div>}

      {hasOpen && (
        <>
          <div style={{ fontSize: '11px', color: 'var(--alive)', fontWeight: 600, marginBottom: '8px', letterSpacing: '1px' }}>
            OPEN ({markets.length} market{markets.length !== 1 ? 's' : ''}, {currentOpenPreds.length} position{currentOpenPreds.length !== 1 ? 's' : ''})
          </div>

          {markets.map((g) => {
            const q = g.question;
            const expanded = expandedMarkets.has(q);
            return (
              <React.Fragment key={q}>
                <div className="position-item" style={{ cursor: 'pointer' }} onClick={() => toggleMarket(q)}>
                  <div className="position-header">
                    <span>
                      <span style={{ marginRight: '6px', fontSize: '10px', color: 'var(--text-dim)' }}>
                        {expanded ? '\u25BC' : '\u25B6'}
                      </span>
                      <SourceTag source={g.source} />
                      <span className={`prediction-side ${g.side.toLowerCase()}`}>{g.side}</span>
                      {' '}
                      <span className="prediction-question">{g.question}</span>
                    </span>
                    <span className={g.totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                      {g.totalPnl >= 0 ? '+' : ''}{formatCost(g.totalPnl)}
                    </span>
                  </div>
                  <div className="position-detail">
                    {g.positions.length} position{g.positions.length !== 1 ? 's' : ''} | {g.totalShares.toFixed(2)} shares
                    | cost {formatCost(g.totalCost)} &rarr; mkt {formatCost(g.totalValue)}
                    {g.end_date && ` | exp ${g.end_date.slice(0, 10)}`}
                  </div>
                </div>
                {expanded && g.positions.map((p) => (
                  <div key={`pred-${p.id}`} className="position-item"
                       style={{ paddingLeft: '24px', borderBottom: '1px solid var(--border)', opacity: 0.85 }}>
                    <div className="position-header">
                      <span style={{ fontSize: '11px' }}>
                        #{p.id} | {p.shares?.toFixed(2)} shares
                        | {formatPct(p.entry_odds)} &rarr; {formatPct(p.current_odds)}
                        | cost {formatCost(p.cost_basis)} &rarr; mkt {formatCost(p.market_value)}
                      </span>
                      <span className={p.unrealized_pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}
                            style={{ fontSize: '11px' }}>
                        {p.unrealized_pnl >= 0 ? '+' : ''}{formatCost(p.unrealized_pnl)}
                      </span>
                    </div>
                  </div>
                ))}
              </React.Fragment>
            );
          })}

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

      {hasClosed && (() => {
        const closedCount = closedPos.length + currentClosedPreds.length;
        const closedPnl = [...currentClosedPreds, ...closedPos].reduce(
          (sum, p) => sum + (p.pnl ?? 0), 0,
        );
        return (
          <div style={{ marginTop: hasOpen ? '16px' : 0, borderTop: hasOpen ? '1px solid var(--border)' : 'none' }}>
            <div
              onClick={() => setClosedOpen(!closedOpen)}
              style={{
                fontSize: '11px', color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '1px',
                padding: hasOpen ? '10px 0 4px' : '0 0 4px', cursor: 'pointer', userSelect: 'none',
              }}
            >
              {closedOpen ? '\u25BC' : '\u25B6'} CLOSED ({closedCount})
              <span style={{ fontWeight: 400, marginLeft: '8px', color: closedPnl >= 0 ? '#44ff88' : '#ff4444' }}>
                {closedPnl >= 0 ? '+' : ''}{formatCost(closedPnl)}
              </span>
            </div>

            {closedOpen && (
              <>
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
          </div>
        );
      })()}

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
