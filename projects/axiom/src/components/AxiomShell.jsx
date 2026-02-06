import React, { useState, useEffect, useRef, useCallback } from 'react'
import useShellChat from '../hooks/useShellChat'

export default function AxiomShell() {
  const { messages, sendMessage, isLoading, activeTools, availableTools, clearHistory } = useShellChat()
  const [input, setInput] = useState('')
  const [health, setHealth] = useState(null)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  // Health check on mount
  useEffect(() => {
    fetch('/api/health', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setHealth(data.status === 'ok' ? 'ok' : 'error'))
      .catch(() => setHealth('error'))
  }, [])

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, activeTools])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = useCallback((e) => {
    e.preventDefault()
    if (!input.trim() || isLoading) return
    sendMessage(input.trim())
    setInput('')
  }, [input, isLoading, sendMessage])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }, [handleSubmit])

  return (
    <div className="axiom-shell">
      <div className="shell-top-bar">
        <div className="shell-title">AXIOM SHELL</div>
        <div className="shell-top-actions">
          {messages.length > 0 && (
            <button className="btn shell-clear-btn" onClick={clearHistory} disabled={isLoading}>
              Clear
            </button>
          )}
          <a href="#/" className="shell-nav-link">Dashboard</a>
          <span className={`shell-health-dot ${health || 'checking'}`} title={health || 'checking'} />
        </div>
      </div>

      <div className="shell-messages">
        {messages.length === 0 && !isLoading && (
          <div className="shell-welcome">
            <div className="shell-welcome-title">AXIOM</div>
            <div className="shell-welcome-sub">Actuator eXploration and Implementation Operating Module</div>
            <div className="shell-welcome-guide">
              <p>AXIOM has persistent memory, its own research history, and operator tools that let it act on its knowledge base.</p>
              <ul>
                <li><strong>Run research sessions</strong> — ask AXIOM to run a session and it will execute a full director/analyst pipeline autonomously. Takes 30-120s. Try: <em>"Run a status assessment session"</em></li>
                <li><strong>Query the actuator taxonomy</strong> — look up any actuator by name, category, or status. AXIOM merges seed data with everything it has learned. Try: <em>"What actuators are confirmed?"</em></li>
                <li><strong>Inspect past sessions</strong> — pull full transcripts of any prior session including director plans, analyst findings, and synthesis. Try: <em>"Show me session-050"</em></li>
                <li><strong>Update the knowledge base</strong> — add findings, change actuator statuses, or revise feasibility scores directly. Try: <em>"Mark X as theoretical because Y"</em></li>
                <li><strong>Check system capabilities</strong> — see all registry modules, which are active, and their usage stats. Try: <em>"List all capabilities"</em></li>
                <li><strong>Web search</strong> — AXIOM can search the web during any conversation to find current information.</li>
              </ul>
              {availableTools.length > 0 && (
                <div className="shell-tool-count">{availableTools.length} tools active — {availableTools.filter(t => t.type === 'operator').length} operator, {availableTools.filter(t => t.type === 'capability').length} acquired</div>
              )}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i}>
            {/* Tool events appear before the assistant response */}
            {msg.role === 'assistant' && msg.toolEvents && (
              <div className="shell-tool-events">
                {msg.toolEvents.map((evt, j) => (
                  <div key={j} className={`shell-tool-event ${evt.type}`}>
                    {evt.type === 'tool_start' && (
                      <span>[{evt.name}: {typeof evt.input === 'object' ? JSON.stringify(evt.input).slice(0, 80) : evt.input}]</span>
                    )}
                    {evt.type === 'tool_result' && (
                      <span>[{evt.name} {evt.error ? 'failed' : 'done'}]</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className={`shell-message ${msg.role}${msg.error ? ' error' : ''}`}>
              <span className="shell-message-prefix">
                {msg.role === 'user' ? '> ' : 'AXIOM: '}
              </span>
              <span className="shell-message-content">{msg.content}</span>
            </div>
            {msg.role === 'assistant' && msg.tokens && (
              <div className="shell-message-meta">
                {msg.tokens.total.toLocaleString()} tokens | {(msg.duration / 1000).toFixed(1)}s
                {msg.searchCount > 0 && ` | ${msg.searchCount} searches`}
              </div>
            )}
          </div>
        ))}

        {/* Live tool activity */}
        {isLoading && activeTools.length > 0 && (
          <div className="shell-tool-events">
            {activeTools.map((name, i) => (
              <div key={i} className="shell-tool-event tool_start">
                <span className="shell-thinking-dot" />{name}...
              </div>
            ))}
          </div>
        )}

        {isLoading && activeTools.length === 0 && (
          <div className="shell-thinking">
            <span className="shell-thinking-dot" />
            {messages.length === 0 ? 'Connecting...' : 'Thinking...'}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form className="shell-input-bar" onSubmit={handleSubmit}>
        <span className="shell-input-prompt">&gt;</span>
        <input
          ref={inputRef}
          type="text"
          className="shell-input"
          placeholder="Type a message..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="btn btn-primary shell-send-btn" disabled={isLoading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
