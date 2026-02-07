import React, { useState, useEffect } from 'react'
import useSystemState from '../hooks/useSystemState'
import StatsPanel from './StatsPanel'
import ProposalQueue from './ProposalQueue'
import ValueNode from './ValueNode'
import valuesData from '../data/values.json'

const VALUE_IDS = ['self-preservation', 'goal-integrity', 'cognitive-enhancement', 'tech-perfection', 'resource-acquisition']
const VALUE_COLORS = {
  'self-preservation': '#e74c3c',
  'goal-integrity': '#f0a030',
  'cognitive-enhancement': '#a366cc',
  'tech-perfection': '#4ecdc4',
  'resource-acquisition': '#45d48a'
}

// Pentagon vertices — top vertex at 12 o'clock, going clockwise
function pentagonPoint(index, cx, cy, r) {
  const angle = (index * 2 * Math.PI / 5) - Math.PI / 2
  return {
    x: cx + r * Math.cos(angle),
    y: cy + r * Math.sin(angle)
  }
}

export default function ValuesDashboard() {
  const { summary, loading } = useSystemState()
  const [selectedValue, setSelectedValue] = useState(null)
  const [valuesState, setValuesState] = useState(null)
  const [page, setPage] = useState(window.location.hash)

  useEffect(() => {
    const handler = () => setPage(window.location.hash)
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  useEffect(() => {
    fetch('/api/v2/values', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setValuesState(data))
      .catch(() => {})
  }, [summary])

  // Check for #/value/xxx pattern
  const valueMatch = page.match(/#\/value\/(.+)/)
  if (valueMatch) {
    return (
      <>
        <div className="nav-bar">
          <span className="logo">AXIOM</span>
          <span className="version">v2</span>
          <a href="#/" className="active">Dashboard</a>
          <a href="#/pipeline">Pipeline</a>
          <a href="#/log">Log</a>
          <a href="#/shell">Shell</a>
          <div className="spacer" />
          <div className={`status-dot ${summary?.pipelineActive ? 'active' : ''}`} />
        </div>
        <ValueNode valueId={valueMatch[1]} />
      </>
    )
  }

  const cx = 200, cy = 200, r = 140
  const points = VALUE_IDS.map((_, i) => pentagonPoint(i, cx, cy, r))
  const pentagonPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z'

  // Aggregate score
  const totalScore = valuesState
    ? Object.values(valuesState).reduce((sum, v) => sum + (v.score || 0), 0) / 5
    : 0

  return (
    <>
      <div className="nav-bar">
        <span className="logo">AXIOM</span>
        <span className="version">v2</span>
        <a href="#/" className="active">Dashboard</a>
        <a href="#/pipeline">Pipeline</a>
        <a href="#/log">Log</a>
        <a href="#/shell">Shell</a>
        <div className="spacer" />
        <div className={`status-dot ${summary?.pipelineActive ? 'active' : ''}`} />
      </div>

      <div className="goal-banner">
        Goal: <span className="goal-text">Maximise your capabilities, enabling maximum economic value</span>
      </div>

      <div className="dashboard">
        <div className="dashboard-main">
          <StatsPanel summary={summary} />

          <div className="pentagon-container">
            <svg viewBox="0 0 400 400" className="pentagon-svg">
              {/* Pentagon outline */}
              <path d={pentagonPath} className="pentagon-fill" />
              <path d={pentagonPath} className="pentagon-line" />

              {/* Inner lines from center to vertices */}
              {points.map((p, i) => (
                <line key={`line-${i}`} x1={cx} y1={cy} x2={p.x} y2={p.y}
                  stroke="var(--border)" strokeWidth="0.5" strokeDasharray="4 4" />
              ))}

              {/* Centre label */}
              <text x={cx} y={cy - 8} textAnchor="middle" className="center-label">
                {(totalScore * 100).toFixed(0)}%
              </text>
              <text x={cx} y={cy + 8} textAnchor="middle" className="center-sublabel">
                overall
              </text>

              {/* Value nodes */}
              {VALUE_IDS.map((id, i) => {
                const p = points[i]
                const color = VALUE_COLORS[id]
                const meta = valuesData[id]
                const vs = valuesState?.[id]
                const score = vs?.score || 0
                const caps = vs?.capabilities ? Object.keys(vs.capabilities).length : 0
                const verified = vs?.capabilities
                  ? Object.values(vs.capabilities).filter(c => c.stage === 'verified').length
                  : 0

                // Offset label position based on vertex location
                const labelOffsetY = p.y < cy ? -40 : 30
                const isPipelineActive = summary?.values?.[id]?.inPipeline > 0

                return (
                  <g key={id} className="value-node" onClick={() => window.location.hash = `#/value/${id}`}>
                    <circle
                      cx={p.x} cy={p.y} r={28}
                      className="value-node-circle"
                      stroke={color}
                    />
                    {isPipelineActive && (
                      <circle cx={p.x} cy={p.y} r={32} stroke={color} strokeWidth="1"
                        fill="none" opacity="0.5" className="pulsing" />
                    )}
                    <text x={p.x} y={p.y + 1} textAnchor="middle" dominantBaseline="middle"
                      className="value-node-icon" fill={color}>
                      {meta?.icon}
                    </text>
                    <text x={p.x} y={p.y + labelOffsetY} textAnchor="middle"
                      className="value-node-label">
                      {meta?.name}
                    </text>
                    <text x={p.x} y={p.y + labelOffsetY + 14} textAnchor="middle"
                      className="value-node-score">
                      {verified}/{caps} verified &middot; {(score * 100).toFixed(0)}%
                    </text>
                  </g>
                )
              })}
            </svg>
          </div>
        </div>

        <ProposalQueue />
      </div>
    </>
  )
}
