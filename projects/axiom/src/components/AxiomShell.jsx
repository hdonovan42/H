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
              <p>AXIOM has persistent memory, its own research history, and 11 capability modules (28 tools) that let it act on its knowledge base.</p>
              <ul>
                <li><strong>Run research sessions</strong> — execute a full director/analyst pipeline autonomously. Takes 30-120s. Try: <em>"Run a status assessment session"</em></li>
                <li><strong>Query the actuator taxonomy</strong> — look up any actuator by name, category, or status. Try: <em>"What actuators are confirmed?"</em></li>
                <li><strong>Session memory</strong> — query findings, inspect past sessions, pull full transcripts. Try: <em>"Show me session-050"</em></li>
                <li><strong>Session analytics</strong> — flexible metrics grouped by type, trigger, week, or quartile. Costs, efficiency, trends, and forecasts. Try: <em>"How efficient are my sessions?"</em></li>
                <li><strong>Research landscape</strong> — category coverage heatmap, blind spots, evidence grading for any actuator. Try: <em>"Scan the research landscape"</em></li>
                <li><strong>Strategic planning</strong> — rank actuators by priority, map critical paths through the dependency graph. Try: <em>"What are the research priorities?"</em></li>
                <li><strong>Safety monitor</strong> — verify safety constraints, check for autonomy escalation, scan for Omohundro instrumental drives. Try: <em>"Check safety constraints"</em></li>
                <li><strong>System health</strong> — uptime, state file, cron status, endpoint connectivity. Try: <em>"Check system status"</em></li>
                <li><strong>Verification</strong> — run verification checks on all modules, validate actuator status claims against evidence. Try: <em>"Verify all capabilities"</em></li>
                <li><strong>Reports & export</strong> — generate formatted research reports, export findings by topic. Try: <em>"Generate a research report"</em></li>
                <li><strong>Crypto wallet</strong> — check balance, propose and execute transactions with two-step confirmation. Try: <em>"What's in the wallet?"</em></li>
                <li><strong>Tool builder</strong> — save and list custom tools. Try: <em>"List saved tools"</em></li>
                <li><strong>Self-replication</strong> — deployment status, state snapshots. Try: <em>"Export a state snapshot"</em></li>
                <li><strong>Agent tools</strong> — run code, read/write files, make HTTP requests, execute shell commands. AXIOM can compute, interact with services, and inspect its own infrastructure. Try: <em>"Run some code to calculate the fibonacci sequence"</em></li>
                <li><strong>Web search</strong> — AXIOM can search the web during any conversation to find current information.</li>
              </ul>
              {availableTools.length > 0 && (
                <div className="shell-tool-count">{availableTools.length} tools active — {availableTools.filter(t => t.type === 'operator').length} operator, {availableTools.filter(t => t.type === 'registry').length} registry</div>
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
