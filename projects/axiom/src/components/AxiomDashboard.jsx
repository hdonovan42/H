import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { getSimulator, UnitStatus } from '../simulation/AgentSimulator'
import { ApiAdapter } from '../simulation/ApiAdapter'
import { scenarios } from '../simulation/scenarios/axiom-sessions'
import actuatorsData from '../data/actuators.json'
import hypothesesData from '../data/hypotheses.json'
import ActuatorGraph from './ActuatorGraph'
import ActuatorDetail from './ActuatorDetail'
import HypothesisPanel from './HypothesisPanel'
import SessionLog from './SessionLog'
import ResearchPanel from './ResearchPanel'
import useCliState from '../hooks/useCliState'

const STATUS_OPTIONS = ['confirmed', 'theoretical', 'blocked', 'impossible']

export default function AxiomDashboard() {
  const [simulator] = useState(() => getSimulator())
  const [state, setState] = useState(() => simulator.getState())
  const [selectedScenario, setSelectedScenario] = useState(scenarios[0])
  const [speed, setSpeed] = useState(1)
  const [selectedActuator, setSelectedActuator] = useState(null)
  const [escalationMessage, setEscalationMessage] = useState('')
  const [mode, setMode] = useState('simulation')
  const [apiStatus, setApiStatus] = useState(null)
  const [apiError, setApiError] = useState(null)
  const [statusFilter, setStatusFilter] = useState([])
  const [blockerCount, setBlockerCount] = useState(0)
  const [rightTab, setRightTab] = useState('live')
  const { summary: cliSummary, fullState: cliFullState, fetchFullState: cliFetchFull, loading: cliLoading } = useCliState({ autoFetchFull: rightTab === 'research' })

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

  const handleNodeClick = useCallback((actuator) => {
    setSelectedActuator(actuator)
  }, [])

  const closeDetail = useCallback(() => {
    setSelectedActuator(null)
  }, [])

  const handleEscalationDecision = useCallback((action) => {
    if (state.pendingEscalation) {
      simulator.resolveChiefEscalation(state.pendingEscalation.id, {
        action,
        message: escalationMessage || null
      })
      setEscalationMessage('')
      setBlockerCount(prev => prev + 1)
    }
  }, [simulator, state.pendingEscalation, escalationMessage])

  const handleModeChange = useCallback(async (e) => {
    const newMode = e.target.value

    if (newMode === 'real') {
      setApiStatus('checking')
      setApiError(null)

      const adapter = new ApiAdapter()
      const health = await adapter.healthCheck()

      if (health.ok) {
        setApiStatus('ok')
        setApiError(null)
        simulator.setMode('real', adapter)
        setMode('real')
      } else {
        setApiStatus('error')
        setApiError(health.error)
      }
    } else {
      simulator.setMode('simulation', null)
      setMode('simulation')
      setApiStatus(null)
      setApiError(null)
    }
  }, [simulator])

  const toggleStatusFilter = useCallback((status) => {
    setStatusFilter(prev => {
      if (prev.includes(status)) {
        return prev.filter(s => s !== status)
      }
      return [...prev, status]
    })
  }, [])

  // Merge actuator data with CLI revised feasibility
  const mergedActuators = useMemo(() => {
    if (!cliSummary?.revisedFeasibility) return actuatorsData
    const revised = cliSummary.revisedFeasibility
    if (Object.keys(revised).length === 0) return actuatorsData
    return actuatorsData.map(a =>
      revised[a.id] !== undefined ? { ...a, feasibility: revised[a.id], _revised: true } : a
    )
  }, [cliSummary?.revisedFeasibility])

  // Stats
  const stats = useMemo(() => {
    const units = Array.from(state.units.values())
    const confirmedCount = mergedActuators.filter(a => a.status === 'confirmed').length
    const simTokens = units.reduce((sum, u) => sum + (u.stats?.tokensUsed || 0), 0)
    return {
      active: units.filter(u => u.status === UnitStatus.ACTIVE).length,
      tokens: simTokens + (cliSummary?.totalTokens || 0),
      searches: cliSummary?.totalSearches || 0,
      confirmed: confirmedCount,
      sessions: cliSummary?.sessionCount || 0
    }
  }, [state.units, mergedActuators, cliSummary])

  const overallStatus = state.isRunning
    ? (state.isPaused ? 'paused' : 'active')
    : (stats.active > 0 ? 'completed' : 'idle')

  return (
    <div className="axiom-dashboard">
      {/* Left: Control + Hypotheses */}
      <div className="panel control-panel">
        <div className="panel-header">
          <span className="panel-title">AXIOM Control</span>
          <div className="status-indicator">
            <span className={`status-dot ${overallStatus}`}></span>
            <span>{overallStatus.toUpperCase()}</span>
          </div>
        </div>
        <div className="panel-content">
          <div className="control-content">
            <div className="session-input">
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
                  {'>'} Start
                </button>
              ) : (
                <button className="btn btn-secondary" onClick={handlePause}>
                  {state.isPaused ? '> Resume' : '|| Pause'}
                </button>
              )}
              <button
                className="btn btn-secondary"
                onClick={handleReset}
                disabled={!state.isRunning && stats.active === 0 && stats.tokens === 0}
              >
                x Reset
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

            <div className="mode-control">
              <div className="mode-toggle">
                <label>Mode:</label>
                <select
                  value={mode}
                  onChange={handleModeChange}
                  disabled={state.isRunning}
                >
                  <option value="simulation">Simulation</option>
                  <option value="real">Real (API)</option>
                </select>
                <span className={`mode-status-dot ${apiStatus === 'ok' ? 'connected' : apiStatus === 'checking' ? 'checking' : apiStatus === 'error' ? 'error' : ''}`}></span>
              </div>
              {apiStatus === 'error' && apiError && (
                <div className="api-error">{apiError}</div>
              )}
              {apiStatus === 'ok' && (
                <div className="api-connected">API connected</div>
              )}
            </div>

            <div className="stats-bar">
              <div className="stat">
                <span className="stat-value">{stats.active}</span>
                <span className="stat-label">Active</span>
              </div>
              <div className="stat">
                <span className="stat-value">{stats.tokens.toLocaleString()}</span>
                <span className="stat-label">Tokens</span>
              </div>
              <div className="stat">
                <span className="stat-value">{stats.confirmed}</span>
                <span className="stat-label">Confirmed</span>
              </div>
              <div className="stat">
                <span className="stat-value">{stats.sessions}</span>
                <span className="stat-label">Sessions</span>
              </div>
              <div className="stat">
                <span className="stat-value">{stats.searches}</span>
                <span className="stat-label">Searches</span>
              </div>
            </div>
          </div>

          {selectedScenario && (
            <div className="objective-bar">
              <div className="objective-label">Objective</div>
              <div className="objective-text">{selectedScenario.description}</div>
            </div>
          )}

          <HypothesisPanel hypotheses={hypothesesData} />
        </div>
      </div>

      {/* Centre: Actuator Graph */}
      <div className="panel graph-panel">
        <div className="panel-header">
          <span className="panel-title">Actuator Graph</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
            {mergedActuators.length} actuators / {mergedActuators.filter(a => a.status === 'confirmed').length} confirmed
          </span>
        </div>
        <div className="panel-content">
          <div className="graph-filters">
            {STATUS_OPTIONS.map(status => (
              <button
                key={status}
                className={`filter-btn ${statusFilter.length === 0 || statusFilter.includes(status) ? 'active' : ''}`}
                onClick={() => toggleStatusFilter(status)}
              >
                {status}
              </button>
            ))}
          </div>
          <ActuatorGraph
            actuators={mergedActuators}
            onNodeClick={handleNodeClick}
            statusFilter={statusFilter}
          />
          <div className="graph-legend">
            <div className="graph-legend-title">Status</div>
            <div className="graph-legend-item">
              <div className="graph-legend-dot" style={{ background: '#4ecdc4' }}></div>
              Confirmed
            </div>
            <div className="graph-legend-item">
              <div className="graph-legend-dot" style={{ background: '#6272a4' }}></div>
              Theoretical
            </div>
            <div className="graph-legend-item">
              <div className="graph-legend-dot" style={{ background: '#f0c040' }}></div>
              Blocked
            </div>
            <div className="graph-legend-item">
              <div className="graph-legend-dot" style={{ background: '#3d3d5c' }}></div>
              Impossible
            </div>
          </div>
        </div>
      </div>

      {/* Right: Tabbed Log / Research */}
      <div className="panel log-panel">
        <div className="panel-header">
          <div className="log-tabs">
            <button
              className={`log-tab${rightTab === 'live' ? ' active' : ''}`}
              onClick={() => setRightTab('live')}
            >
              Live Log
            </button>
            <button
              className={`log-tab${rightTab === 'research' ? ' active' : ''}`}
              onClick={() => {
                setRightTab('research')
                if (!cliFullState) cliFetchFull()
              }}
            >
              Research{cliSummary?.sessionCount ? ` (${cliSummary.sessionCount})` : ''}
            </button>
          </div>
        </div>
        <div className="panel-content">
          {rightTab === 'live' ? (
            <SessionLog
              messages={state.messages}
              units={state.units}
              embedded
            />
          ) : (
            <ResearchPanel
              cliState={cliFullState}
              cliSummary={cliSummary}
              loading={cliLoading}
              onRefresh={cliFetchFull}
            />
          )}
        </div>
      </div>

      {/* Actuator Detail Modal */}
      {selectedActuator && (
        <ActuatorDetail
          actuator={selectedActuator}
          actuators={mergedActuators}
          cliState={cliFullState}
          onClose={closeDetail}
        />
      )}

      {/* Approval Modal (Blocker Queue) */}
      {state.pendingEscalation && (
        <div className="modal-overlay escalation-overlay">
          <div className="modal escalation-modal">
            <div className="modal-header escalation-header">
              <span className="modal-title">AXIOM: APPROVAL REQUIRED</span>
            </div>
            <div className="modal-content">
              <div className="escalation-blocker-id">
                B{String(blockerCount + 1).padStart(3, '0')}
              </div>

              <div className="escalation-from">
                <span className="detail-label">From</span>
                <span className="detail-value">{state.pendingEscalation.fromUnitName}</span>
              </div>

              <div className="escalation-problem">
                <div className="escalation-problem-label">Blocker</div>
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
                  Approve
                </button>
                <button
                  className="btn btn-deny"
                  onClick={() => handleEscalationDecision('deny')}
                >
                  Deny
                </button>
                <button
                  className="btn btn-defer"
                  onClick={() => handleEscalationDecision('defer')}
                >
                  Defer
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
