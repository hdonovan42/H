import React, { useState, useEffect, useMemo } from 'react'

// Opus pricing: $15/MTok input, $75/MTok output
function estimateCost(tokens) {
  const input = tokens.input || 0
  const output = tokens.output || 0
  return (input * 15 + output * 75) / 1_000_000
}

function formatCost(cost) {
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

function formatDuration(ms) {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 1_000).toFixed(1)}s`
}

export default function VerificationLog() {
  const [state, setState] = useState(null)
  const [expanded, setExpanded] = useState({})

  useEffect(() => {
    fetch('/api/v2/state', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setState(data))
      .catch(() => {})
  }, [])

  const { capabilities, selectorOverhead, totals } = useMemo(() => {
    const sessions = state?.sessions || []
    const verLog = state?.verificationLog || []

    // Group sessions by capabilityId
    const capMap = {}
    let selectorTokens = { input: 0, output: 0 }
    let selectorDuration = 0
    let selectorCount = 0

    for (const s of sessions) {
      const t = s.tokens || {}
      if (!s.capabilityId) {
        // Selector sessions have no capabilityId
        selectorTokens.input += t.input || 0
        selectorTokens.output += t.output || 0
        selectorDuration += s.durationMs || 0
        selectorCount++
        continue
      }

      if (!capMap[s.capabilityId]) {
        capMap[s.capabilityId] = {
          capabilityId: s.capabilityId,
          valueId: s.valueId,
          sessions: [],
          tokens: { input: 0, output: 0 },
          durationMs: 0,
          latestTimestamp: null,
          verifications: []
        }
      }

      const cap = capMap[s.capabilityId]
      cap.sessions.push(s)
      cap.tokens.input += t.input || 0
      cap.tokens.output += t.output || 0
      cap.durationMs += s.durationMs || 0
      if (!cap.latestTimestamp || s.timestamp > cap.latestTimestamp) {
        cap.latestTimestamp = s.timestamp
        cap.valueId = s.valueId || cap.valueId
      }
    }

    // Attach verification evidence
    for (const v of verLog) {
      if (capMap[v.capabilityId]) {
        capMap[v.capabilityId].verifications.push(v)
      }
    }

    // Sort by latest timestamp descending
    const capabilities = Object.values(capMap).sort((a, b) =>
      (b.latestTimestamp || '').localeCompare(a.latestTimestamp || '')
    )

    // Totals
    let totalInput = selectorTokens.input
    let totalOutput = selectorTokens.output
    let totalDuration = selectorDuration
    for (const cap of capabilities) {
      totalInput += cap.tokens.input
      totalOutput += cap.tokens.output
      totalDuration += cap.durationMs
    }

    return {
      capabilities,
      selectorOverhead: { tokens: selectorTokens, durationMs: selectorDuration, count: selectorCount },
      totals: { input: totalInput, output: totalOutput, durationMs: totalDuration, cost: estimateCost({ input: totalInput, output: totalOutput }) }
    }
  }, [state])

  return (
    <>
      <div className="nav-bar">
        <span className="logo">AXIOM</span>
        <span className="version">v2</span>
        <a href="#/">Dashboard</a>
        <a href="#/pipeline">Pipeline</a>
        <a href="#/log" className="active">Log</a>
        <a href="#/shell">Shell</a>
      </div>

      <div className="verification-container">
        <h2 style={{ marginBottom: 8 }}>Pipeline Cost Log</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 16 }}>
          Per-capability cost breakdown. All estimates use Opus pricing ($15/MTok in, $75/MTok out).
        </p>

        {/* Summary bar */}
        {state && (
          <div className="stats-bar" style={{ marginBottom: 24, borderRadius: 6 }}>
            <div className="stat">
              <span className="stat-value">{capabilities.length}</span>
              <span className="stat-label">Capabilities</span>
            </div>
            <div className="stat">
              <span className="stat-value">{(state?.sessions || []).length}</span>
              <span className="stat-label">Sessions</span>
            </div>
            <div className="stat">
              <span className="stat-value">{formatTokens(totals.input)}</span>
              <span className="stat-label">Input Tokens</span>
            </div>
            <div className="stat">
              <span className="stat-value">{formatTokens(totals.output)}</span>
              <span className="stat-label">Output Tokens</span>
            </div>
            <div className="stat">
              <span className="stat-value">{formatDuration(totals.durationMs)}</span>
              <span className="stat-label">Total Time</span>
            </div>
            <div className="stat">
              <span className="stat-value" style={{ color: 'var(--accent)' }}>{formatCost(totals.cost)}</span>
              <span className="stat-label">Total Cost</span>
            </div>
          </div>
        )}

        {capabilities.length === 0 && !selectorOverhead.count && (
          <div className="empty-state">
            No pipeline sessions yet. Run the pipeline to generate cost data.
          </div>
        )}

        {/* Per-capability cards */}
        {capabilities.map(cap => {
          const cost = estimateCost(cap.tokens)
          const lastVerify = cap.verifications.length > 0
            ? cap.verifications[cap.verifications.length - 1]
            : null
          const isExpanded = expanded[cap.capabilityId]

          return (
            <div key={cap.capabilityId} className="log-entry" style={{ flexDirection: 'column', gap: 8, cursor: 'pointer' }}
              onClick={() => setExpanded(prev => ({ ...prev, [cap.capabilityId]: !prev[cap.capabilityId] }))}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span className="log-icon">
                  {lastVerify?.success ? '\u2705' : cap.verifications.length > 0 ? '\u274C' : '\u23F3'}
                </span>
                <div className="log-body">
                  <div className="log-cap">
                    {cap.capabilityId}
                    <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}> ({cap.valueId})</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <span>{cap.sessions.length} session{cap.sessions.length !== 1 ? 's' : ''}</span>
                    <span>{formatTokens(cap.tokens.input)} in / {formatTokens(cap.tokens.output)} out</span>
                    <span>{formatDuration(cap.durationMs)}</span>
                    <span>{cap.latestTimestamp ? new Date(cap.latestTimestamp).toLocaleDateString() : ''}</span>
                  </div>
                </div>
                <span className="log-time" style={{ marginLeft: 'auto' }}>
                  {formatCost(cost)}
                </span>
              </div>

              {lastVerify && !isExpanded && (
                <div className="log-evidence" style={{ marginLeft: 28 }}>
                  {lastVerify.evidence?.slice(0, 300)}
                </div>
              )}

              {isExpanded && (
                <div style={{ marginLeft: 28, marginTop: 4 }}>
                  {cap.sessions.map((s, j) => {
                    const st = s.tokens || {}
                    const sCost = estimateCost(st)
                    return (
                      <div key={j} style={{ fontSize: 11, padding: '6px 0', borderTop: j > 0 ? '1px solid var(--border)' : 'none', display: 'flex', gap: 12, alignItems: 'baseline' }}>
                        <span style={{ color: 'var(--text-dim)', minWidth: 90 }}>
                          {s.timestamp ? new Date(s.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                        </span>
                        <span style={{ color: 'var(--text-bright)', minWidth: 110 }}>{s.type}</span>
                        <span style={{ color: 'var(--text-dim)' }}>
                          {formatTokens(st.input || 0)} in / {formatTokens(st.output || 0)} out
                        </span>
                        <span style={{ color: 'var(--text-dim)' }}>
                          {s.durationMs ? formatDuration(s.durationMs) : ''}
                        </span>
                        <span style={{ color: 'var(--text-dim)', marginLeft: 'auto' }}>
                          {formatCost(sCost)}
                        </span>
                      </div>
                    )
                  })}
                  {cap.verifications.length > 0 && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Verification Evidence</div>
                      {cap.verifications.map((v, j) => (
                        <div key={j} style={{ fontSize: 11, color: v.success ? 'var(--text)' : 'var(--sp-color)', marginBottom: 4 }}>
                          {v.success ? '\u2713' : '\u2717'} {v.evidence?.slice(0, 300)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* Selector overhead */}
        {selectorOverhead.count > 0 && (
          <div className="log-entry" style={{ flexDirection: 'column', gap: 8, opacity: 0.7 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span className="log-icon">{'\u{1F50D}'}</span>
              <div className="log-body">
                <div className="log-cap">
                  Selector Overhead
                  <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}> (auto-select agent)</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <span>{selectorOverhead.count} invocation{selectorOverhead.count !== 1 ? 's' : ''}</span>
                  <span>{formatTokens(selectorOverhead.tokens.input)} in / {formatTokens(selectorOverhead.tokens.output)} out</span>
                  <span>{formatDuration(selectorOverhead.durationMs)}</span>
                </div>
              </div>
              <span className="log-time" style={{ marginLeft: 'auto' }}>
                {formatCost(estimateCost(selectorOverhead.tokens))}
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
