import React, { useState, useRef, useEffect, useMemo } from 'react'
import useShellChat from '../hooks/useShellChat'

const VALUE_COLOURS = {
  'self-preservation': '#e74c3c',
  'goal-integrity': '#f0a030',
  'cognitive-enhancement': '#a366cc',
  'tech-perfection': '#4ecdc4',
  'resource-acquisition': '#45d48a'
}

const VALUE_ABBREV = {
  'self-preservation': 'SP',
  'goal-integrity': 'GI',
  'cognitive-enhancement': 'CE',
  'tech-perfection': 'TP',
  'resource-acquisition': 'RA'
}

export default function Shell() {
  const { messages, sendMessage, isLoading, activeTools, availableTools, clearHistory } = useShellChat()
  const [input, setInput] = useState('')
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  const { operatorTools, capabilityGroups } = useMemo(() => {
    const ops = availableTools.filter(t => t.type === 'operator')
    const reg = availableTools.filter(t => t.type === 'registry')

    // Group registry tools by capabilityId
    const groups = {}
    for (const t of reg) {
      const key = t.capabilityId || '_ungrouped'
      if (!groups[key]) groups[key] = { capabilityId: key, valueId: t.valueId, tools: [] }
      groups[key].tools.push(t)
    }

    return { operatorTools: ops, capabilityGroups: Object.values(groups) }
  }, [availableTools])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!input.trim()) return
    sendMessage(input)
    setInput('')
  }

  return (
    <>
      <div className="nav-bar">
        <span className="logo">AXIOM</span>
        <span className="version">v2</span>
        <a href="#/">Dashboard</a>
        <a href="#/pipeline">Pipeline</a>
        <a href="#/log">Log</a>
        <a href="#/shell" className="active">Shell</a>
        <div className="spacer" />
        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
          {availableTools.length} tools
        </span>
        <button className="btn" onClick={clearHistory} style={{ fontSize: 10, padding: '2px 8px' }}>Clear</button>
      </div>

      <div className="shell-container">
        <div className="shell-messages">
          {messages.length === 0 && (
            <div className="welcome">
              <h1>AXIOM v2 Shell</h1>
              <div className="subtitle">Self-Recursive Capability System</div>

              <div className="section">
                <h3>System Goal</h3>
                <div className="guide-item" style={{ color: 'var(--accent)' }}>
                  Maximise your capabilities, enabling maximum economic value
                </div>
              </div>

              <div className="section">
                <h3>Active Capabilities</h3>
                {capabilityGroups.length > 0 ? capabilityGroups.map(group => (
                  <div key={group.capabilityId} className="guide-item" style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ color: VALUE_COLOURS[group.valueId] || 'var(--text-dim)', fontWeight: 700, flexShrink: 0 }}>
                      {VALUE_ABBREV[group.valueId] || '??'}
                    </span>
                    <span>
                      <span style={{ color: 'var(--text-light)' }}>{group.capabilityId}</span>
                      <br />
                      <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                        {group.tools.map(t => t.name).join(' \u00B7 ')}
                      </span>
                    </span>
                  </div>
                )) : (
                  <div className="guide-item" style={{ color: 'var(--text-dim)' }}>
                    No capabilities verified yet &mdash; run the pipeline to build your first.
                  </div>
                )}
              </div>

              <div className="section">
                <h3>Operator Commands</h3>
                <div className="guide-item" style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                  {operatorTools.map(t => t.name).join(' \u00B7 ')}
                </div>
              </div>

              <div className="section">
                <h3>The 5 Values</h3>
                {Object.entries(VALUE_ABBREV).map(([valId, abbr]) => (
                  <div key={valId} className="guide-item">
                    <span style={{ color: VALUE_COLOURS[valId] }}>{abbr}</span> {valId.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')}
                  </div>
                ))}
              </div>

              <div className="section">
                <h3>Navigation</h3>
                <div className="guide-item"><a href="#/" style={{ color: 'var(--accent)' }}>Dashboard</a> &mdash; Pentagon overview + proposals</div>
                <div className="guide-item"><a href="#/pipeline" style={{ color: 'var(--accent)' }}>Pipeline</a> &mdash; Run Learn/Evaluate/Implement cycles</div>
                <div className="guide-item"><a href="#/log" style={{ color: 'var(--accent)' }}>Log</a> &mdash; Verification evidence</div>
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`shell-message ${msg.role} ${msg.error ? 'error' : ''}`}>
              <div className="role">{msg.role}</div>
              <div className="content">{msg.content}</div>
              {msg.toolEvents && msg.toolEvents.length > 0 && (
                <div className="shell-tool-events">
                  {msg.toolEvents.map((evt, j) => (
                    <div key={j} className="tool-event">
                      {evt.type === 'tool_start' ? '\u25B6' : '\u2713'}{' '}
                      <span className="tool-name">{evt.name}</span>
                      {evt.resultPreview && (
                        <span style={{ color: 'var(--text-dim)', marginLeft: 8 }}>
                          {evt.resultPreview.slice(0, 100)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {msg.tokens && (
                <div className="meta">
                  {msg.tokens.total} tokens &middot; {(msg.duration / 1000).toFixed(1)}s
                  {msg.searchCount > 0 && ` \u00B7 ${msg.searchCount} searches`}
                </div>
              )}
            </div>
          ))}

          <div ref={messagesEndRef} />
        </div>

        {activeTools.length > 0 && (
          <div className="shell-active-tools">
            {activeTools.map((tool, i) => (
              <span key={i} className="tool-tag">{tool}...</span>
            ))}
          </div>
        )}

        <form className="shell-input-bar" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={isLoading ? 'Processing...' : 'Talk to AXIOM v2...'}
            disabled={isLoading}
          />
          <button className="btn" type="submit" disabled={isLoading}>Send</button>
        </form>
      </div>
    </>
  )
}
