import React from 'react'
import actuatorsOriginal from '../data/actuators.json'

const CATEGORY_LABELS = {
  physical: 'Physical',
  cognitive: 'Cognitive',
  social: 'Social',
  digital: 'Digital',
  economic: 'Economic',
  informational: 'Informational',
  meta: 'Meta'
}

export default function ActuatorDetail({ actuator, actuators, cliState, onClose }) {
  if (!actuator) return null

  const linkedHypotheses = actuator.linkedHypotheses || []
  const dependencies = actuator.dependencies || []

  // Find actuators that depend on this one
  const dependents = actuators
    .filter(a => a.dependencies?.includes(actuator.id))
    .map(a => a.name)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px' }}>
        <div className="modal-header">
          <span className="modal-title">{actuator.name}</span>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-content">
          <div className="detail-row">
            <span className="detail-label">ID</span>
            <span className="detail-value" style={{ fontFamily: 'inherit', fontSize: '11px' }}>{actuator.id}</span>
          </div>

          <div className="detail-row">
            <span className="detail-label">Category</span>
            <span className="detail-value">{CATEGORY_LABELS[actuator.category] || actuator.category}</span>
          </div>

          <div className="detail-row">
            <span className="detail-label">Status</span>
            <span className="detail-value">
              <span className={`actuator-status-badge ${actuator.status}`}>
                {actuator.status}
              </span>
            </span>
          </div>

          <div className="detail-row">
            <span className="detail-label">Risk</span>
            <span className="detail-value" style={{
              color: actuator.risk === 'extreme' ? '#e06060' :
                     actuator.risk === 'high' ? '#f0a030' :
                     actuator.risk === 'medium' ? '#f0c040' : '#9fb3c8'
            }}>
              {actuator.risk?.toUpperCase()}
            </span>
          </div>

          <div style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '10px', color: '#5a7186', textTransform: 'uppercase', marginBottom: '4px' }}>Description</div>
            <div style={{ fontSize: '12px', color: '#9fb3c8', lineHeight: '1.5' }}>{actuator.description}</div>
          </div>

          <div style={{ display: 'flex', gap: '20px', marginBottom: '12px' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '10px', color: '#5a7186', textTransform: 'uppercase', marginBottom: '4px' }}>
                Feasibility ({Math.round(actuator.feasibility * 100)}%)
                {actuator._revised && <span style={{ color: '#4ecdc4', marginLeft: '6px', fontSize: '9px' }}>REVISED</span>}
              </div>
              <div className="feasibility-bar" style={{ position: 'relative' }}>
                <div className="feasibility-fill" style={{ width: `${actuator.feasibility * 100}%` }} />
                {actuator._revised && (() => {
                  const orig = actuatorsOriginal.find(a => a.id === actuator.id)
                  return orig ? (
                    <div style={{
                      position: 'absolute',
                      top: -2,
                      left: `${orig.feasibility * 100}%`,
                      width: '2px',
                      height: 'calc(100% + 4px)',
                      background: '#5a7186',
                      opacity: 0.7
                    }} title={`Original: ${Math.round(orig.feasibility * 100)}%`} />
                  ) : null
                })()}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '10px', color: '#5a7186', textTransform: 'uppercase', marginBottom: '4px' }}>
                Desirability ({Math.round(actuator.desirability * 100)}%)
              </div>
              <div className="feasibility-bar">
                <div className="feasibility-fill" style={{
                  width: `${actuator.desirability * 100}%`,
                  background: '#d48045'
                }} />
              </div>
            </div>
          </div>

          {actuator._revised && (
            <div style={{
              marginBottom: '12px',
              padding: '10px',
              background: 'rgba(78, 205, 196, 0.05)',
              borderLeft: '2px solid #4ecdc4'
            }}>
              <div style={{ fontSize: '10px', color: '#4ecdc4', textTransform: 'uppercase', marginBottom: '4px', letterSpacing: '1px' }}>
                Research Update
              </div>
              <div style={{ fontSize: '11px', color: '#9fb3c8', lineHeight: '1.4' }}>
                Feasibility revised from {Math.round((actuatorsOriginal.find(a => a.id === actuator.id)?.feasibility || 0) * 100)}% to {Math.round(actuator.feasibility * 100)}% based on CLI research sessions.
              </div>
            </div>
          )}

          {dependencies.length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '10px', color: '#5a7186', textTransform: 'uppercase', marginBottom: '4px' }}>Dependencies</div>
              <div>
                {dependencies.map(dep => (
                  <span key={dep} className="dependency-tag">{dep}</span>
                ))}
              </div>
            </div>
          )}

          {dependents.length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '10px', color: '#5a7186', textTransform: 'uppercase', marginBottom: '4px' }}>Required By</div>
              <div>
                {dependents.map(dep => (
                  <span key={dep} className="dependency-tag">{dep}</span>
                ))}
              </div>
            </div>
          )}

          {linkedHypotheses.length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '10px', color: '#5a7186', textTransform: 'uppercase', marginBottom: '4px' }}>Linked Hypotheses</div>
              <div>
                {linkedHypotheses.map(h => (
                  <span key={h} className="dependency-tag" style={{ borderColor: '#4ecdc4', color: '#4ecdc4' }}>{h}</span>
                ))}
              </div>
            </div>
          )}

          {actuator.notes && (
            <div style={{
              padding: '10px',
              background: '#080b12',
              borderLeft: '2px solid #2a3a4e',
              fontSize: '11px',
              color: '#5a7186',
              fontStyle: 'italic',
              lineHeight: '1.4'
            }}>
              {actuator.notes}
            </div>
          )}

          <div style={{ marginTop: '12px', fontSize: '9px', color: '#3a4f63' }}>
            Discovered by: {actuator.discoveredBy || 'unknown'}
          </div>
        </div>
      </div>
    </div>
  )
}
