import React, { useState, useEffect } from 'react'
import valuesData from '../data/values.json'

export default function ValueNode({ valueId }) {
  const [valueState, setValueState] = useState(null)
  const [loading, setLoading] = useState(true)
  const meta = valuesData[valueId]

  useEffect(() => {
    fetch('/api/v2/values', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        setValueState(data[valueId])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [valueId])

  if (loading) return <div className="value-detail"><p>Loading...</p></div>
  if (!meta) return <div className="value-detail"><p>Unknown value: {valueId}</p></div>

  const capabilities = valueState?.capabilities || {}
  const bootstrap = meta.bootstrapCapabilities || []

  // Merge bootstrap with actual state
  const allCaps = bootstrap.map(b => ({
    ...b,
    ...(capabilities[b.id] || {}),
    stage: capabilities[b.id]?.stage || 'pending'
  }))

  // Add any capabilities in state that aren't in bootstrap
  for (const [id, cap] of Object.entries(capabilities)) {
    if (!allCaps.find(c => c.id === id)) {
      allCaps.push({ id, name: id, ...cap })
    }
  }

  const stageBadge = (stage) => {
    const cls = stage === 'verified' ? 'badge-verified'
      : stage === 'proposed' ? 'badge-proposed'
      : ['learning', 'evaluating', 'implementing', 'verifying'].includes(stage) ? 'badge-implementing'
      : stage === 'pending' ? 'badge-pending'
      : 'badge-pending'
    return <span className={`badge ${cls}`}>{stage}</span>
  }

  return (
    <div className="value-detail">
      <a href="#/" className="back-link">&larr; Back to dashboard</a>
      <h2 style={{ color: meta.color }}>{meta.name}</h2>
      <p style={{ color: 'var(--text-dim)', marginBottom: 8 }}>{meta.description}</p>
      <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        Score: {((valueState?.score || 0) * 100).toFixed(0)}%
      </p>

      <div className="cap-list">
        {allCaps.map(cap => (
          <div key={cap.id} className="cap-item">
            <span className="cap-id">{cap.name || cap.id}</span>
            <span className="cap-stage">{stageBadge(cap.stage)}</span>
            <span className="cap-evidence">
              {cap.evidence?.slice(0, 80) || (cap.phase !== undefined ? `Phase ${cap.phase}` : '')}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
