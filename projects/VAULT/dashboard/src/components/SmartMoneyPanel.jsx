import React, { useState, useEffect, useCallback } from 'react';

async function fetchJSON(url, creds) {
  const headers = {};
  if (creds) headers['Authorization'] = 'Basic ' + btoa(creds.user + ':' + creds.pass);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const ACTION_COLORS = {
  veto: '#ff4444',
  boost: '#44ff88',
  momentum_bet: '#4488ff',
  momentum_skip: '#666',
};

const OUTCOME_LABELS = {
  pending: 'Pending',
  won: 'Won',
  lost: 'Lost',
  veto_correct: 'Saved $',
  veto_wrong: 'Missed $',
  skipped: 'Skipped',
};

export default function SmartMoneyPanel({ creds }) {
  const [summary, setSummary] = useState(null);
  const [logEntries, setLogEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([
        fetchJSON('/api/v1/smart-money/summary', creds).catch(() => null),
        fetchJSON('/api/v1/smart-money/log?limit=20', creds).catch(() => []),
      ]);
      setSummary(s);
      setLogEntries(l);
    } catch (e) {
      console.error('Smart money fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, [creds]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, [refresh]);

  if (loading) {
    return <div className="page"><div className="empty">Loading smart money data...</div></div>;
  }

  const s = summary || {};
  const veto = s.veto || {};
  const boost = s.boost || {};
  const momentum = s.momentum || {};
  const hypothesisNet = veto.net_usd || 0;

  return (
    <div className="page">
      {/* Summary bar */}
      <div className="card">
        <div className="card-title">Smart Money Velocity — Summary</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginTop: '8px' }}>
          <StatBox label="Vetoes" value={veto.total || 0} color="#ff4444" />
          <StatBox label="Boosts" value={boost.total || 0} color="#44ff88" />
          <StatBox label="Momentum Bets" value={momentum.total_bets || 0} color="#4488ff" />
          <StatBox label="Skipped" value={momentum.total_skips || 0} color="#666" />
          <StatBox label="Pending" value={s.pending || 0} color="#888" />
        </div>
      </div>

      {/* Hypothesis scorecard */}
      <div className="card" style={{ marginTop: '12px' }}>
        <div className="card-title">Hypothesis: Sharp Moves = Informed Money</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginTop: '8px' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Vetoes Saved</div>
            <div style={{ fontSize: '18px', color: '#44ff88', fontWeight: 600 }}>
              ${(veto.saved_usd || 0).toFixed(2)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
              {veto.correct || 0} correct vetoes
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Vetoes Cost</div>
            <div style={{ fontSize: '18px', color: '#ff4444', fontWeight: 600 }}>
              ${(veto.cost_usd || 0).toFixed(2)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
              {veto.wrong || 0} wrong vetoes
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Net Impact</div>
            <div style={{
              fontSize: '18px',
              fontWeight: 600,
              color: hypothesisNet >= 0 ? '#44ff88' : '#ff4444',
            }}>
              {hypothesisNet >= 0 ? '+' : ''}${hypothesisNet.toFixed(2)}
            </div>
            <div style={{ fontSize: '11px', color: hypothesisNet >= 0 ? '#44ff88' : '#ff4444' }}>
              {hypothesisNet >= 0 ? 'Hypothesis CONFIRMED' : 'Hypothesis REJECTED'}
            </div>
          </div>
        </div>

        {/* Momentum + Boost stats */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px' }}>Momentum Bets P&L</div>
            <span style={{ color: momentum.pnl >= 0 ? '#44ff88' : '#ff4444', fontWeight: 600 }}>
              {momentum.pnl >= 0 ? '+' : ''}${(momentum.pnl || 0).toFixed(2)}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginLeft: '8px' }}>
              {momentum.wins || 0}W / {momentum.losses || 0}L
            </span>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px' }}>Boost Bets P&L</div>
            <span style={{ color: boost.pnl >= 0 ? '#44ff88' : '#ff4444', fontWeight: 600 }}>
              {boost.pnl >= 0 ? '+' : ''}${(boost.pnl || 0).toFixed(2)}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginLeft: '8px' }}>
              {boost.wins || 0}W / {boost.losses || 0}L
            </span>
          </div>
        </div>
      </div>

      {/* Recent signals table */}
      <div className="card" style={{ marginTop: '12px' }}>
        <div className="card-title">Recent Signals</div>
        {logEntries.length === 0 ? (
          <div className="empty">No smart money signals recorded yet</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-dim)' }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Time</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Action</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Market</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px' }}>Velocity</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px' }}>Amount</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {logEntries.map((entry) => (
                  <tr key={entry.id} style={{ borderBottom: '1px solid var(--border-dim, rgba(255,255,255,0.05))' }}>
                    <td style={{ padding: '6px 8px', color: 'var(--text-dim)' }}>
                      {entry.ts?.slice(5, 16).replace('T', ' ')}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <span style={{
                        padding: '2px 6px',
                        borderRadius: '3px',
                        fontSize: '10px',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        background: (ACTION_COLORS[entry.action_taken] || '#666') + '22',
                        color: ACTION_COLORS[entry.action_taken] || '#666',
                      }}>
                        {entry.action_taken}
                      </span>
                    </td>
                    <td style={{ padding: '6px 8px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.question || entry.market_id}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--font-mono, monospace)' }}>
                      {entry.v_1h != null && <span>{(entry.v_1h * 100).toFixed(0)}pp/1h</span>}
                      {entry.v_1h != null && entry.v_6h != null && ' '}
                      {entry.v_6h != null && <span>{(entry.v_6h * 100).toFixed(0)}pp/6h</span>}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      {entry.amount_usd != null ? `$${entry.amount_usd.toFixed(2)}` : '—'}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <span style={{
                        color: entry.outcome === 'won' || entry.outcome === 'veto_correct' ? '#44ff88'
                             : entry.outcome === 'lost' || entry.outcome === 'veto_wrong' ? '#ff4444'
                             : 'var(--text-dim)',
                      }}>
                        {OUTCOME_LABELS[entry.outcome] || entry.outcome}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatBox({ label, value, color }) {
  return (
    <div style={{
      padding: '8px 12px',
      borderRadius: '6px',
      background: color + '11',
      border: `1px solid ${color}33`,
    }}>
      <div style={{ fontSize: '20px', fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{label}</div>
    </div>
  );
}
