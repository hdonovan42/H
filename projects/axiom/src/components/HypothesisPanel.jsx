import React, { useMemo, useState } from 'react'

export default function HypothesisPanel({ hypotheses, actuators = [] }) {
  const [view, setView] = useState('unconfirmed')

  const unconfirmed = useMemo(() =>
    actuators
      .filter(a => a.status !== 'confirmed')
      .sort((a, b) => b.feasibility - a.feasibility),
    [actuators]
  )

  const limitingFactors = useMemo(() => {
    const blockerMap = new Map()
    const actuatorMap = new Map(actuators.map(a => [a.id, a]))
    const hypothesisMap = new Map(hypotheses.map(h => [h.id, h]))
    const confirmedIds = new Set(actuators.filter(a => a.status === 'confirmed').map(a => a.id))

    for (const a of unconfirmed) {
      for (const depId of (a.dependencies || [])) {
        if (confirmedIds.has(depId)) continue
        if (!blockerMap.has(depId)) {
          const dep = actuatorMap.get(depId)
          blockerMap.set(depId, {
            id: depId, name: dep?.name || depId, type: 'actuator',
            status: dep?.status || 'unknown', feasibility: dep?.feasibility,
            blockedActuators: new Set()
          })
        }
        blockerMap.get(depId).blockedActuators.add(a.id)
      }

      for (const hId of (a.linkedHypotheses || [])) {
        const h = hypothesisMap.get(hId)
        if (h && h.status === 'passed') continue
        if (!blockerMap.has(hId)) {
          blockerMap.set(hId, {
            id: hId, name: h?.name || hId, type: 'hypothesis',
            status: h?.status || 'unknown',
            blockedActuators: new Set()
          })
        }
        blockerMap.get(hId).blockedActuators.add(a.id)
      }
    }

    return Array.from(blockerMap.values())
      .map(f => ({ ...f, blockedActuators: Array.from(f.blockedActuators) }))
      .sort((a, b) => b.blockedActuators.length - a.blockedActuators.length)
  }, [actuators, hypotheses, unconfirmed])

  return (
    <div className="hypothesis-panel">
      <div className="hypothesis-title" style={{ display: 'flex', gap: 0 }}>
        <button className={`log-tab${view === 'unconfirmed' ? ' active' : ''}`}
          onClick={() => setView('unconfirmed')}>
          Unconfirmed ({unconfirmed.length})
        </button>
        <button className={`log-tab${view === 'limitingFactors' ? ' active' : ''}`}
          onClick={() => setView('limitingFactors')}>
          Limiting Factors ({limitingFactors.length})
        </button>
      </div>
      <div className="hypothesis-list">
        {view === 'unconfirmed' ? (
          unconfirmed.map(a => (
            <div key={a.id} className={`hypothesis-card status-${a.status}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="hypothesis-id" style={{ fontSize: '0.65rem' }}>{a.id}</span>
                <span className={`hypothesis-status ${a.status}`}>
                  {a.status}{a._discovered ? ' +' : ''}{a._revised ? ' *' : ''}
                </span>
              </div>
              <div className="hypothesis-name">{a.name}</div>
              <div className="hypothesis-meta">
                <span style={{
                  color: a.feasibility >= 0.7 ? 'var(--accent)' : a.feasibility >= 0.4 ? 'var(--status-warning)' : 'var(--text-dim)'
                }}>
                  {a.feasibility.toFixed(2)}
                </span>
                <span>{a.category}</span>
                <span style={{ color: a.risk === 'extreme' ? '#ff5555' : a.risk === 'high' ? 'var(--status-warning)' : 'var(--text-dim)' }}>
                  {a.risk}
                </span>
              </div>
            </div>
          ))
        ) : (
          limitingFactors.map(f => (
            <div key={f.id} className={`hypothesis-card status-${f.status}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="hypothesis-id" style={{ fontSize: '0.65rem' }}>
                  {f.type === 'hypothesis' ? f.id.toUpperCase() : f.id}
                </span>
                <span className={`hypothesis-status ${f.status}`}>{f.status}</span>
              </div>
              <div className="hypothesis-name">{f.name}</div>
              <div className="hypothesis-meta">
                {f.type === 'actuator' && f.feasibility != null && (
                  <span style={{
                    color: f.feasibility >= 0.7 ? 'var(--accent)' : f.feasibility >= 0.4 ? 'var(--status-warning)' : 'var(--text-dim)'
                  }}>
                    {f.feasibility.toFixed(2)}
                  </span>
                )}
                <span style={{ color: 'var(--accent)' }}>
                  blocks {f.blockedActuators.length}
                </span>
              </div>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '4px', lineHeight: 1.4 }}>
                {f.blockedActuators.join(', ')}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
