import React, { useState } from 'react'
import usePipelineStore, { runPipeline, runAuto, killPipeline } from '../hooks/usePipelineStore.js'

const PHASES = ['Select', 'Learn', 'Evaluate', 'Approve', 'Implement', 'Verify', 'Cold Verify', 'Deploy']

export default function PipelineView() {
  const { events, running, pipelineState } = usePipelineStore()
  const [runTarget, setRunTarget] = useState({ capabilityId: '', valueId: '' })
  const [operatorResponse, setOperatorResponse] = useState('')
  const [responding, setResponding] = useState(false)

  const handleOperatorRespond = async (reqId) => {
    if (!operatorResponse.trim()) return
    setResponding(true)
    try {
      const res = await fetch('/api/v2/pipeline/operator-respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ response: operatorResponse.trim() })
      })
      const data = await res.json()
      if (data.success) setOperatorResponse('')
    } catch (err) {
      console.error('Operator respond failed:', err)
    } finally {
      setResponding(false)
    }
  }

  const pendingOpRequest = pipelineState?.operatorRequest

  const activePhase = pipelineState?.pipeline?.phase
  const phaseIndex = activePhase
    ? { select: 0, learn: 1, evaluate: 2, approve: 3, implement: 4, verify: 5, 'cold-verify': 6, deploy: 7 }[activePhase] ?? -1
    : -1

  return (
    <>
      <div className="nav-bar">
        <span className="logo">AXIOM</span>
        <span className="version">v2</span>
        <a href="#/">Dashboard</a>
        <a href="#/pipeline" className="active">Pipeline</a>
        <a href="#/log">Log</a>
        <a href="#/shell">Shell</a>
      </div>

      <div className="pipeline-container">
        <h2 style={{ marginBottom: 8 }}>Pipeline Engine</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 24 }}>
          Select &rarr; Learn &rarr; Evaluate &rarr; Approve &rarr; Implement &rarr; Verify &rarr; Cold Verify &rarr; Deploy
        </p>

        <div className="pipeline-phases">
          {PHASES.map((name, i) => (
            <div
              key={name}
              className={`pipeline-phase${i === phaseIndex ? ' active' : ''}${i < phaseIndex ? ' completed' : ''}`}
            >
              <div className="phase-name">{name}</div>
              <div className="phase-status">
                {i === phaseIndex ? 'Running...' : i < phaseIndex ? 'Done' : 'Waiting'}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Capability ID (e.g. sp-monitoring)"
            value={runTarget.capabilityId}
            onChange={e => setRunTarget(prev => ({ ...prev, capabilityId: e.target.value }))}
            style={{ padding: '8px 12px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-bright)', fontFamily: 'var(--font)', fontSize: 12, flex: 1, minWidth: 200 }}
          />
          <select
            value={runTarget.valueId}
            onChange={e => setRunTarget(prev => ({ ...prev, valueId: e.target.value }))}
            style={{ padding: '8px 12px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-bright)', fontFamily: 'var(--font)', fontSize: 12 }}
          >
            <option value="">Select value...</option>
            <option value="self-preservation">Self-Preservation</option>
            <option value="goal-integrity">Goal-Content Integrity</option>
            <option value="cognitive-enhancement">Cognitive Enhancement</option>
            <option value="tech-perfection">Technological Perfection</option>
            <option value="resource-acquisition">Resource Acquisition</option>
          </select>
          <button className="btn" onClick={() => runPipeline(runTarget)} disabled={running || !runTarget.capabilityId || !runTarget.valueId}>
            {running ? 'Running...' : 'Run Pipeline'}
          </button>
          <button className="btn" onClick={runAuto} disabled={running} style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
            Auto-Select Next
          </button>
          {running && (
            <button className="btn" onClick={killPipeline} style={{ borderColor: '#ff4444', color: '#ff4444' }}>
              Kill
            </button>
          )}
        </div>

        {pendingOpRequest && (
          <div style={{ background: 'rgba(255, 170, 0, 0.1)', border: '2px solid var(--gi-color, #ffaa00)', borderRadius: 6, padding: 16, marginBottom: 16 }}>
            <div style={{ color: 'var(--gi-color, #ffaa00)', fontWeight: 700, fontSize: 13, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
              Pipeline Paused — Operator Response Needed
            </div>
            <div style={{ color: 'var(--text-bright)', fontSize: 12, marginBottom: 8 }}>
              {pendingOpRequest.request}
            </div>
            {pendingOpRequest.context && (
              <div style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 12 }}>
                Context: {pendingOpRequest.context}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                placeholder="Your response..."
                value={operatorResponse}
                onChange={e => setOperatorResponse(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleOperatorRespond(pendingOpRequest.id)}
                style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-input)', border: '1px solid var(--gi-color, #ffaa00)', borderRadius: 4, color: 'var(--text-bright)', fontFamily: 'var(--font)', fontSize: 12 }}
              />
              <button
                className="btn"
                onClick={() => handleOperatorRespond(pendingOpRequest.id)}
                disabled={responding || !operatorResponse.trim()}
                style={{ borderColor: 'var(--gi-color, #ffaa00)', color: 'var(--gi-color, #ffaa00)' }}
              >
                {responding ? 'Sending...' : 'Respond'}
              </button>
            </div>
          </div>
        )}

        {events.length > 0 && (
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, padding: 16, maxHeight: 400, overflowY: 'auto' }}>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
              Pipeline Events
            </div>
            {events.map((evt, i) => (
              <div key={i} style={{ fontSize: 11, color: evt.type.includes('error') ? 'var(--sp-color)' : 'var(--text)', marginBottom: 4, fontFamily: 'var(--font)' }}>
                {evt.type === 'selector_start' ? (
                  <span style={{ color: 'var(--text-dim)' }}>Opus selector agent starting investigation...</span>
                ) : evt.type === 'selector_result' ? (
                  <div>
                    <span style={{ color: 'var(--accent)' }}>Selected: {evt.selected}</span>
                    {evt.toolInvocations > 0 && (
                      <span style={{ color: 'var(--text-dim)', marginLeft: 8, fontSize: 10 }}>
                        {evt.toolInvocations} tool calls{evt.searchCount > 0 && `, ${evt.searchCount} searches`}
                        {evt.durationMs && ` \u00B7 ${(evt.durationMs / 1000).toFixed(1)}s`}
                      </span>
                    )}
                    <div style={{ color: 'var(--text)', marginTop: 4, paddingLeft: 8 }}>{evt.reasoning}</div>
                    {evt.investigation && (
                      <div style={{ color: 'var(--text-dim)', marginTop: 4, paddingLeft: 8, fontSize: 10 }}>
                        <strong>Investigation:</strong> {evt.investigation}
                      </div>
                    )}
                    {evt.riskAssessment && (
                      <div style={{ color: 'var(--text-dim)', marginTop: 2, paddingLeft: 8, fontSize: 10 }}>
                        <strong>Risk:</strong> {evt.riskAssessment}
                      </div>
                    )}
                    {evt.expectedOutcome && (
                      <div style={{ color: 'var(--text-dim)', marginTop: 2, paddingLeft: 8, fontSize: 10 }}>
                        <strong>Expected outcome:</strong> {evt.expectedOutcome}
                      </div>
                    )}
                    {evt.alternatives?.length > 0 && (
                      <div style={{ color: 'var(--text-dim)', marginTop: 4, paddingLeft: 8, fontSize: 10 }}>
                        <strong>Alternatives:</strong>
                        {evt.alternatives.map((a, j) => (
                          <div key={j} style={{ paddingLeft: 8 }}>{a.id}: {a.reason}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : evt.type === 'selector_failed' ? (
                  <span style={{ color: 'var(--sp-color)' }}>SELECTOR FAILED — {evt.error || 'unknown error'}</span>
                ) : evt.type === 'tool_start' && evt.phase === 'select' ? (
                  <span style={{ color: 'var(--text-dim)' }}>
                    <span style={{ color: 'var(--accent)' }}>[select]</span> {'\u25B6'} {evt.name}
                  </span>
                ) : evt.type === 'tool_result' && evt.phase === 'select' ? (
                  <span style={{ color: 'var(--text-dim)' }}>
                    <span style={{ color: 'var(--accent)' }}>[select]</span> {'\u2713'} {evt.name}
                    {evt.resultPreview && <span style={{ marginLeft: 8 }}>{evt.resultPreview.slice(0, 100)}</span>}
                  </span>
                ) : evt.type === 'pipeline_result' && evt.phase === 'cold-verify' ? (
                  <div>
                    <span style={{ color: evt.success ? 'var(--ra-color)' : 'var(--sp-color)', fontWeight: 600 }}>
                      [cold-verify] {evt.success ? 'PASSED' : 'FAILED'}
                    </span>
                    {evt.evidence && (
                      <span style={{ color: 'var(--text-dim)', marginLeft: 8, fontSize: 10 }}>{evt.evidence}</span>
                    )}
                  </div>
                ) : evt.type === 'pipeline_result' && evt.phase === 'deploy' ? (
                  <div>
                    <span style={{ color: evt.success ? 'var(--ra-color)' : 'var(--sp-color)', fontWeight: 600 }}>
                      [deploy] {evt.success ? 'PASSED' : 'FAILED'}
                    </span>
                    {evt.missingDeps?.length > 0 && (
                      <div style={{ color: 'var(--sp-color)', marginTop: 4, paddingLeft: 8, fontSize: 10 }}>
                        Missing deps: <strong>{evt.missingDeps.join(', ')}</strong>
                        <div style={{ color: 'var(--text-dim)', marginTop: 2 }}>
                          These packages will be lost after deploy. Add them to server/package.json.
                        </div>
                      </div>
                    )}
                    {evt.success && evt.evidence && (
                      <span style={{ color: 'var(--text-dim)', marginLeft: 8, fontSize: 10 }}>{evt.evidence}</span>
                    )}
                  </div>
                ) : evt.type === 'operator_request' ? (
                  <div style={{ background: 'rgba(255, 170, 0, 0.08)', border: '1px solid var(--gi-color, #ffaa00)', borderRadius: 4, padding: 8, margin: '4px 0' }}>
                    <span style={{ color: 'var(--gi-color, #ffaa00)', fontWeight: 600 }}>OPERATOR REQUEST:</span>{' '}
                    <span style={{ color: 'var(--text-bright)' }}>{evt.request}</span>
                    {evt.context && <div style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 4 }}>Context: {evt.context}</div>}
                  </div>
                ) : evt.type === 'operator_response' ? (
                  <div style={{ margin: '4px 0' }}>
                    <span style={{ color: 'var(--gi-color, #ffaa00)', fontWeight: 600 }}>OPERATOR RESPONDED:</span>{' '}
                    <span style={{ color: 'var(--text-bright)' }}>{evt.response}</span>
                  </div>
                ) : (
                  <>
                    <span style={{ color: 'var(--text-dim)' }}>[{evt.type}]</span>{' '}
                    {evt.phase && <span style={{ color: 'var(--accent)' }}>{evt.phase}</span>}
                    {evt.error && <span style={{ color: 'var(--sp-color)' }}> {evt.error}</span>}
                    {evt.capabilityId && ` ${evt.capabilityId}`}
                    {evt.proposalId && ` proposal: ${evt.proposalId}`}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
