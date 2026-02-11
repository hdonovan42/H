import React from 'react';

function formatTs(ts) {
  if (!ts) return '';
  return ts.slice(0, 16).replace('T', ' ');
}

export default function CycleLog({ cycles }) {
  if (!cycles || cycles.length === 0) {
    return (
      <div className="card">
        <div className="card-title">Recent Decisions</div>
        <div className="empty">No cycles recorded yet</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-title">Recent Decisions</div>
      <ul className="cycle-list">
        {cycles.map((c) => (
          <li key={c.id} className="cycle-item">
            <span className={`action-badge ${c.action || 'wait'}`}>
              {c.action || 'pending'}
            </span>
            <div>
              <div className="cycle-meta">
                {formatTs(c.ts_start)}
                {' | '}${(c.total_cost || 0).toFixed(4)}
                {' | '}{c.rounds_used || 0}r
                {c.balance_after != null && ` | bal: $${c.balance_after.toFixed(2)}`}
              </div>
              {c.reasoning && (
                <div className="cycle-reasoning">{c.reasoning}</div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
