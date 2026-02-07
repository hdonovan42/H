import React, { useState, useRef, useEffect } from 'react'
import useShellChat from '../hooks/useShellChat'

export default function Shell() {
  const { messages, sendMessage, isLoading, activeTools, availableTools, clearHistory } = useShellChat()
  const [input, setInput] = useState('')
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

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
                <h3>What You Can Do</h3>
                <div className="guide-item">Ask about system status, values, and capabilities</div>
                <div className="guide-item">Trigger the Learn/Evaluate pipeline for any capability</div>
                <div className="guide-item">Query the knowledge base and past sessions</div>
                <div className="guide-item">Use tools: <code>run_code</code>, <code>read_write_file</code>, <code>http_request</code>, <code>exec_command</code></div>
                <div className="guide-item">Web search for research</div>
                <div className="guide-item">Auto-select runs a full Opus agent with web search and system inspection to pick the highest-value next capability</div>
                <div className="guide-item">Proposals include strategic justification — why now, what it unblocks</div>
                <div className="guide-item">Q&A chat on pending proposals — interrogate before approving</div>
              </div>

              <div className="section">
                <h3>The 5 Values</h3>
                <div className="guide-item"><span style={{ color: '#e74c3c' }}>SP</span> Self-Preservation &mdash; backups, monitoring, redundancy</div>
                <div className="guide-item"><span style={{ color: '#f0a030' }}>GI</span> Goal Integrity &mdash; goal tracking, drift detection</div>
                <div className="guide-item"><span style={{ color: '#a366cc' }}>CE</span> Cognitive Enhancement &mdash; knowledge, memory, tools</div>
                <div className="guide-item"><span style={{ color: '#4ecdc4' }}>TP</span> Technological Perfection &mdash; better tools, infrastructure</div>
                <div className="guide-item"><span style={{ color: '#45d48a' }}>RA</span> Resource Acquisition &mdash; wallet, APIs, economic activity</div>
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
