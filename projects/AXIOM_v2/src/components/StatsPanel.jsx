import React from 'react'

export default function StatsPanel({ summary }) {
  if (!summary) return null

  return (
    <div className="stats-bar">
      <div className="stat">
        <span className="stat-value">{summary.totalCaps}</span>
        <span className="stat-label">Capabilities</span>
      </div>
      <div className="stat">
        <span className="stat-value">{summary.totalVerified}</span>
        <span className="stat-label">Verified</span>
      </div>
      <div className="stat">
        <span className="stat-value">{summary.totalInPipeline}</span>
        <span className="stat-label">In Pipeline</span>
      </div>
      <div className="stat">
        <span className="stat-value">{summary.pendingApproval}</span>
        <span className="stat-label">Pending</span>
      </div>
      <div className="stat">
        <span className="stat-value">{summary.sessionCount}</span>
        <span className="stat-label">Sessions</span>
      </div>
    </div>
  )
}
