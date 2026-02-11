import React, { useState } from 'react';

function formatCost(n) {
  if (n == null) return '$0.00';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function shortModel(model) {
  if (!model) return 'unknown';
  if (model.includes('opus')) return 'Opus';
  if (model.includes('sonnet')) return 'Sonnet';
  if (model.includes('haiku')) return 'Haiku';
  return model.split('-').slice(0, 2).join('-');
}

export default function CostBreakdown({ costs }) {
  const [tab, setTab] = useState('model');

  if (!costs) {
    return (
      <div className="card">
        <div className="card-title">Cost Breakdown</div>
        <div className="empty">No cost data yet</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Cost Breakdown</span>
        <span style={{ display: 'flex', gap: '4px' }}>
          <button
            className={`nav-link ${tab === 'model' ? 'active' : ''}`}
            onClick={() => setTab('model')}
            style={{ fontSize: '10px', padding: '2px 8px' }}
          >
            By Model
          </button>
          <button
            className={`nav-link ${tab === 'day' ? 'active' : ''}`}
            onClick={() => setTab('day')}
            style={{ fontSize: '10px', padding: '2px 8px' }}
          >
            By Day
          </button>
        </span>
      </div>

      {tab === 'model' ? (
        <table className="cost-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Calls</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {costs.by_model.map((m) => (
              <tr key={m.model}>
                <td>{shortModel(m.model)}</td>
                <td className="num">{m.calls}</td>
                <td className="num">{((m.input_tokens || 0) + (m.output_tokens || 0)).toLocaleString()}</td>
                <td className="num">{formatCost(m.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="cost-table">
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Calls</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {costs.by_day.map((d) => (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td className="num">{d.calls}</td>
                <td className="num">{formatCost(d.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
