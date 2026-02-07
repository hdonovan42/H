import React, { useState, useEffect } from 'react'

export default function VerificationLog() {
  const [state, setState] = useState(null)

  useEffect(() => {
    fetch('/api/v2/state', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setState(data))
      .catch(() => {})
  }, [])

  const log = (state?.verificationLog || []).slice().reverse()

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
        <h2 style={{ marginBottom: 8 }}>Verification Log</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 24 }}>
          Real test results and evidence for capability verification.
        </p>

        {log.length === 0 && (
          <div className="empty-state">
            No verification entries yet. Run the pipeline to generate verifications.
          </div>
        )}

        {log.map((entry, i) => (
          <div key={i} className="log-entry">
            <span className="log-icon">
              {entry.success ? '\u2705' : '\u274C'}
            </span>
            <div className="log-body">
              <div className="log-cap">
                {entry.capabilityId}
                <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}> ({entry.valueId})</span>
              </div>
              <div className="log-evidence">{entry.evidence?.slice(0, 300)}</div>
            </div>
            <span className="log-time">
              {entry.timestamp ? new Date(entry.timestamp).toLocaleString() : ''}
              {entry.durationMs ? ` (${(entry.durationMs / 1000).toFixed(1)}s)` : ''}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
