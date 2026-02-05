import React from 'react'

export default function HypothesisPanel({ hypotheses }) {
  return (
    <div className="hypothesis-panel">
      <div className="hypothesis-title">Hypotheses</div>
      <div className="hypothesis-list">
        {hypotheses.map(h => (
          <div key={h.id} className={`hypothesis-card status-${h.status}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="hypothesis-id">{h.id}</span>
              <span className={`hypothesis-priority ${h.priority}`}>{h.priority}</span>
            </div>
            <div className="hypothesis-name">{h.name}</div>
            <div className="hypothesis-meta">
              <span>{h.status}</span>
              <span>{h.cost}</span>
              {h.blockedBy.length > 0 && (
                <span style={{ color: 'var(--status-warning)' }}>
                  blocked by {h.blockedBy.join(', ')}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
