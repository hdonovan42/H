import React, { useState } from 'react'

export default function ResearchPanel({ cliState, cliSummary, loading, onRefresh }) {
  const [expandedSession, setExpandedSession] = useState(null)

  if (!cliState && !cliSummary) {
    return (
      <div className="research-panel-content">
        <div className="research-empty">
          No CLI sessions recorded yet. Run <code>npm run cli</code> to start.
        </div>
      </div>
    )
  }

  const keyFindings = cliState?.knowledgeBase?.keyFindings || []
  const revisedFeasibility = cliSummary?.revisedFeasibility || {}
  const sessions = cliState?.sessions || []
  const revisedEntries = Object.entries(revisedFeasibility)
  const hypothesisResults = cliSummary?.hypothesisResults || {}
  const hypothesisEntries = Object.entries(hypothesisResults)

  return (
    <div className="research-panel-content">
      {loading && <div className="research-loading">Loading...</div>}

      <button className="btn btn-secondary research-refresh" onClick={onRefresh}>
        Refresh
      </button>

      {/* Key Findings */}
      {keyFindings.length > 0 && (
        <div className="research-section">
          <div className="research-section-title">Key Findings ({keyFindings.length})</div>
          {keyFindings.map((finding, i) => (
            <div key={i} className="finding-card">
              {finding}
            </div>
          ))}
        </div>
      )}

      {/* Revised Scores */}
      {revisedEntries.length > 0 && (
        <div className="research-section">
          <div className="research-section-title">Revised Feasibility</div>
          {revisedEntries.map(([id, score]) => (
            <div key={id} className="revised-row">
              <span className="revised-id">{id}</span>
              <span className="revised-score">{Math.round(score * 100)}%</span>
            </div>
          ))}
        </div>
      )}

      {/* Hypothesis Results */}
      {hypothesisEntries.length > 0 && (
        <div className="research-section">
          <div className="research-section-title">Hypothesis Results</div>
          {hypothesisEntries.map(([id, status]) => (
            <div key={id} className="revised-row">
              <span className="revised-id">{id}</span>
              <span className={`hypothesis-result-status status-${status}`}>{status}</span>
            </div>
          ))}
        </div>
      )}

      {/* Session History */}
      {sessions.length > 0 && (
        <div className="research-section">
          <div className="research-section-title">Session History ({sessions.length})</div>
          {[...sessions].reverse().map(session => {
            const isExpanded = expandedSession === session.id
            const tokens = session.tokens
              ? (session.tokens.input || 0) + (session.tokens.output || 0)
              : 0
            return (
              <div key={session.id} className="session-card">
                <div
                  className="session-card-header"
                  onClick={() => setExpandedSession(isExpanded ? null : session.id)}
                >
                  <span className="session-id">{session.id}</span>
                  <span className="session-meta">
                    {session.type} / {tokens.toLocaleString()} tokens
                    {session.searchCount > 0 && ` / ${session.searchCount} searches`}
                  </span>
                  <span className="session-expand">{isExpanded ? '-' : '+'}</span>
                </div>
                {isExpanded && session.synthesis && (
                  <div className="session-card-body">
                    <div className="session-synthesis">{session.synthesis}</div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {keyFindings.length === 0 && revisedEntries.length === 0 && hypothesisEntries.length === 0 && sessions.length === 0 && (
        <div className="research-empty">
          No CLI sessions recorded yet. Run <code>npm run cli</code> to start.
        </div>
      )}
    </div>
  )
}
