import React, { useState, useEffect, useCallback } from 'react'
import { getSimulator, UnitStatus } from '../simulation/AgentSimulator'
import { scenarios } from '../simulation/scenarios/research-mission'
import HierarchyTree from './HierarchyTree'
import OperationsLog from './OperationsLog'

export default function CommandCentre() {
  const [simulator] = useState(() => getSimulator())
  const [state, setState] = useState(() => simulator.getState())
  const [selectedScenario, setSelectedScenario] = useState(scenarios[0])
  const [speed, setSpeed] = useState(1)
  const [selectedUnit, setSelectedUnit] = useState(null)
  const [escalationMessage, setEscalationMessage] = useState('')

  // Subscribe to simulator updates
  useEffect(() => {
    const unsubscribe = simulator.subscribe(setState)
    return unsubscribe
  }, [simulator])

  const handleStart = useCallback(() => {
    simulator.start(selectedScenario)
  }, [simulator, selectedScenario])

  const handlePause = useCallback(() => {
    if (state.isPaused) {
      simulator.resume()
    } else {
      simulator.pause()
    }
  }, [simulator, state.isPaused])

  const handleReset = useCallback(() => {
    simulator.reset()
  }, [simulator])

  const handleSpeedChange = useCallback((e) => {
    const newSpeed = parseFloat(e.target.value)
    setSpeed(newSpeed)
    simulator.setSpeed(newSpeed)
  }, [simulator])

  const handleUnitClick = useCallback((unit) => {
    setSelectedUnit(unit)
  }, [])

  const closeModal = useCallback(() => {
    setSelectedUnit(null)
  }, [])

  const handleEscalationDecision = useCallback((action) => {
    if (state.pendingEscalation) {
      simulator.resolveChiefEscalation(state.pendingEscalation.id, {
        action,
        message: escalationMessage || null
      })
      setEscalationMessage('')
    }
  }, [simulator, state.pendingEscalation, escalationMessage])

  // Calculate stats
  const stats = {
    active: Array.from(state.units.values()).filter(u => u.status === UnitStatus.ACTIVE).length,
    completed: Array.from(state.units.values()).filter(u => u.status === UnitStatus.COMPLETED).length,
    failed: Array.from(state.units.values()).filter(u => u.status === UnitStatus.FAILED).length,
    tokens: Array.from(state.units.values()).reduce((sum, u) => sum + (u.stats?.tokensUsed || 0), 0),
    escalating: Array.from(state.units.values()).filter(u => u.status === UnitStatus.ESCALATING || u.status === UnitStatus.AWAITING_INPUT).length
  }

  const overallStatus = state.isRunning
    ? (state.isPaused ? 'paused' : 'active')
    : (stats.completed > 0 ? 'completed' : 'idle')

  return (
    <div className="command-centre">
      {/* Chief of Staff Panel */}
      <div className="panel chief-panel">
        <div className="panel-header">
          <span className="panel-title">Chief of Staff - Command & Control</span>
          <div className="status-indicator">
            <span className={`status-dot ${overallStatus}`}></span>
            <span>{overallStatus.toUpperCase()}</span>
          </div>
        </div>
        <div className="panel-content">
          <div className="chief-content">
            <div className="mission-input">
              <select
                value={selectedScenario.id}
                onChange={(e) => setSelectedScenario(scenarios.find(s => s.id === e.target.value))}
                disabled={state.isRunning}
              >
                {scenarios.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            <div className="simulation-controls">
              {!state.isRunning ? (
                <button className="btn btn-primary" onClick={handleStart}>
                  ▶ Start Mission
                </button>
              ) : (
                <button className="btn btn-secondary" onClick={handlePause}>
                  {state.isPaused ? '▶ Resume' : '⏸ Pause'}
                </button>
              )}
              <button
                className="btn btn-secondary"
                onClick={handleReset}
                disabled={!state.isRunning && stats.completed === 0}
              >
                ↺ Reset
              </button>

              <div className="speed-control">
                <label>Speed:</label>
                <select value={speed} onChange={handleSpeedChange}>
                  <option value={0.5}>0.5x</option>
                  <option value={1}>1x</option>
                  <option value={2}>2x</option>
                  <option value={4}>4x</option>
                </select>
              </div>
            </div>

            <div className="stats-bar">
              <div className="stat">
                <span className="stat-value">{stats.active}</span>
                <span className="stat-label">Active</span>
              </div>
              <div className="stat">
                <span className="stat-value">{stats.completed}</span>
                <span className="stat-label">Complete</span>
              </div>
              <div className="stat">
                <span className="stat-value" style={{ color: 'var(--status-error)' }}>{stats.failed}</span>
                <span className="stat-label">Failed</span>
              </div>
              <div className="stat">
                <span className="stat-value">{stats.tokens.toLocaleString()}</span>
                <span className="stat-label">Tokens</span>
              </div>
            </div>
          </div>

          {selectedScenario && (
            <div style={{
              marginTop: '12px',
              padding: '10px 12px',
              background: 'var(--bg-dark)',
              borderLeft: '2px solid var(--green-accent)'
            }}>
              <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                Objective
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
                {selectedScenario.description}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Hierarchy Tree Panel */}
      <div className="panel hierarchy-panel">
        <div className="panel-header">
          <span className="panel-title">Chain of Command</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--parchment-dim)' }}>
            Click unit for details
          </span>
        </div>
        <div className="panel-content">
          <HierarchyTree
            units={state.units}
            onUnitClick={handleUnitClick}
          />
        </div>
      </div>

      {/* Operations Log Panel */}
      <OperationsLog
        messages={state.messages}
        units={state.units}
      />

      {/* Unit Detail Modal */}
      {selectedUnit && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{selectedUnit.name}</span>
              <button className="modal-close" onClick={closeModal}>×</button>
            </div>
            <div className="modal-content">
              {selectedUnit.rank === 'company' ? (
                // Company details
                <>
                  <div className="detail-row">
                    <span className="detail-label">Type</span>
                    <span className="detail-value">Company (Swarm)</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Workers</span>
                    <span className="detail-value">{selectedUnit.swarmSize}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Commander</span>
                    <span className="detail-value">{selectedUnit.commandingOfficer}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Status</span>
                    <span className="detail-value">
                      <span className={`status-dot ${selectedUnit.status}`} style={{ display: 'inline-block', marginRight: '0.5rem' }}></span>
                      {selectedUnit.status.toUpperCase()}
                    </span>
                  </div>

                  <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--green-border)' }}>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                      Statistics
                    </div>
                    <div className="detail-row">
                      <span className="detail-label">Completed</span>
                      <span className="detail-value">{selectedUnit.stats?.tasksCompleted || 0}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label">Failed</span>
                      <span className="detail-value">{selectedUnit.stats?.tasksFailed || 0}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label">Tokens Used</span>
                      <span className="detail-value">{selectedUnit.stats?.tokensUsed?.toLocaleString() || 0}</span>
                    </div>
                  </div>
                </>
              ) : (
                // Regular unit details
                <>
                  <div className="detail-row">
                    <span className="detail-label">ID</span>
                    <span className="detail-value">{selectedUnit.id}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Rank</span>
                    <span className="detail-value" style={{ textTransform: 'capitalize' }}>
                      {selectedUnit.rank}
                    </span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Status</span>
                    <span className="detail-value">
                      <span className={`status-dot ${selectedUnit.status}`} style={{ display: 'inline-block', marginRight: '0.5rem' }}></span>
                      {selectedUnit.status.toUpperCase()}
                    </span>
                  </div>
                  {selectedUnit.currentTask && (
                    <div className="detail-row">
                      <span className="detail-label">Current Task</span>
                      <span className="detail-value">{selectedUnit.currentTask}</span>
                    </div>
                  )}
                  <div className="detail-row">
                    <span className="detail-label">Parent</span>
                    <span className="detail-value">
                      {selectedUnit.parentId
                        ? state.units.get(selectedUnit.parentId)?.name || selectedUnit.parentId
                        : '—'}
                    </span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Subordinates</span>
                    <span className="detail-value">
                      {selectedUnit.childrenIds?.length || 0}
                    </span>
                  </div>

                  <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--green-border)' }}>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                      Statistics
                    </div>
                    <div className="detail-row">
                      <span className="detail-label">Completed</span>
                      <span className="detail-value">{selectedUnit.stats?.tasksCompleted || 0}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label">Failed</span>
                      <span className="detail-value">{selectedUnit.stats?.tasksFailed || 0}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label">Tokens Used</span>
                      <span className="detail-value">{selectedUnit.stats?.tokensUsed?.toLocaleString() || 0}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Chief Escalation Decision Modal */}
      {state.pendingEscalation && (
        <div className="modal-overlay escalation-overlay">
          <div className="modal escalation-modal">
            <div className="modal-header escalation-header">
              <span className="modal-title">🔺 CHIEF DECISION REQUIRED</span>
            </div>
            <div className="modal-content">
              <div className="escalation-from">
                <span className="detail-label">From</span>
                <span className="detail-value">{state.pendingEscalation.fromUnitName}</span>
              </div>

              <div className="escalation-problem">
                <div className="escalation-problem-label">Problem</div>
                <div className="escalation-problem-text">{state.pendingEscalation.problem}</div>
              </div>

              {state.pendingEscalation.context && (
                <div className="escalation-context">
                  {state.pendingEscalation.context}
                </div>
              )}

              <div className="escalation-input">
                <label>Additional directive (optional):</label>
                <input
                  type="text"
                  value={escalationMessage}
                  onChange={(e) => setEscalationMessage(e.target.value)}
                  placeholder="Enter instructions..."
                />
              </div>

              <div className="escalation-actions">
                <button
                  className="btn btn-approve"
                  onClick={() => handleEscalationDecision('approve')}
                >
                  ✓ Approve
                </button>
                <button
                  className="btn btn-deny"
                  onClick={() => handleEscalationDecision('deny')}
                >
                  ✕ Deny
                </button>
                <button
                  className="btn btn-defer"
                  onClick={() => handleEscalationDecision('defer')}
                >
                  ⏸ Defer
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
