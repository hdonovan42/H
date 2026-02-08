import React, { useState, useRef, useEffect } from 'react'
import useProposals from '../hooks/useProposals'
import useProposalChat from '../hooks/useProposalChat'

function ProposalDescription({ text }) {
  const [expanded, setExpanded] = useState(false)
  if (!text) return null

  const limit = 500
  const needsTruncate = text.length > limit

  return (
    <div className="description">
      {expanded || !needsTruncate ? text : text.slice(0, limit) + '...'}
      {needsTruncate && (
        <button
          className="btn-link"
          onClick={() => setExpanded(!expanded)}
          style={{ marginLeft: 6, fontSize: '0.8em', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
        >
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}

function Justification({ justification }) {
  if (!justification) return null

  return (
    <div className="justification">
      {justification.limitingFactor && (
        <div className="justification-limiting">{justification.limitingFactor}</div>
      )}
      {justification.whyNow && (
        <div className="justification-detail">{justification.whyNow}</div>
      )}
      {justification.compoundingEffect && (
        <div className="justification-detail">{justification.compoundingEffect}</div>
      )}
      {justification.alternativesConsidered && (
        <div className="justification-alt">{justification.alternativesConsidered}</div>
      )}
    </div>
  )
}

function ProposalChat({ proposalId }) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const { messages, sendMessage, isLoading, clearChat } = useProposalChat(proposalId)
  const messagesEndRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (!open) {
    return (
      <button
        className="btn"
        onClick={() => setOpen(true)}
        style={{ fontSize: 10, marginTop: 8, width: '100%' }}
      >
        Ask a question
      </button>
    )
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!input.trim()) return
    sendMessage(input)
    setInput('')
  }

  return (
    <div className="proposal-chat">
      <div className="proposal-chat-header">
        <span>Q&A</span>
        <button
          className="btn"
          onClick={() => { setOpen(false); clearChat() }}
          style={{ fontSize: 9, padding: '1px 6px' }}
        >
          Close
        </button>
      </div>
      <div className="proposal-chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`proposal-chat-msg ${msg.role}`}>
            <div className="proposal-chat-msg-content">{msg.content}</div>
          </div>
        ))}
        {isLoading && (
          <div className="proposal-chat-msg assistant">
            <div className="proposal-chat-msg-content pulsing">Thinking...</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <form className="proposal-chat-input" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={isLoading ? 'Thinking...' : 'Ask about this proposal...'}
          disabled={isLoading}
        />
      </form>
    </div>
  )
}

export default function ProposalQueue() {
  const { proposals, pending, approve, reject, retryImplement } = useProposals()
  const [pipelineActive, setPipelineActive] = useState(null)

  useEffect(() => {
    const interval = setInterval(() => {
      fetch('/api/v2/pipeline/active', { credentials: 'include' })
        .then(r => r.json())
        .then(data => setPipelineActive(data.active ? data.pipeline : null))
        .catch(() => {})
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  const handleApprove = async (id) => {
    await approve(id)
  }

  const handleReject = async (id) => {
    const reason = prompt('Reason for rejection (optional):') || undefined
    await reject(id, reason)
  }

  const recent = proposals
    .filter(p => p.status !== 'pending_approval')
    .slice(-5)
    .reverse()

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        Proposals {pending.length > 0 && `(${pending.length} pending)`}
      </div>
      <div className="sidebar-content">
        {pending.length === 0 && recent.length === 0 && (
          <div className="empty-state">
            No proposals yet. Run the pipeline to generate proposals.
          </div>
        )}

        {pending.map(p => {
          const files = p.implementation?.files || []
          const verification = p.verification?.test

          return (
            <div key={p.id} className="proposal-card">
              <div className="title">{p.title || p.capabilityId}</div>
              <div className="meta">
                {p.capabilityId} &middot; {p.valueId} &middot; risk: {p.risk || '?'}
              </div>
              <ProposalDescription text={p.description} />
              <Justification justification={p.justification} />
              {files.length > 0 && (
                <div className="meta" style={{ marginTop: 4 }}>
                  {files.length} file{files.length !== 1 ? 's' : ''}: {files.map(f => typeof f === 'string' ? f : f.path || f.file).join(', ')}
                </div>
              )}
              {verification && (
                <div className="meta" style={{ marginTop: 4, fontStyle: 'italic' }}>
                  Verify: {typeof verification === 'string' ? verification.slice(0, 120) : JSON.stringify(verification).slice(0, 120)}
                </div>
              )}
              <div className="actions">
                <button className="btn btn-approve" onClick={() => handleApprove(p.id)}>
                  Approve
                </button>
                <button className="btn btn-reject" onClick={() => handleReject(p.id)}>
                  Reject
                </button>
              </div>
              <ProposalChat proposalId={p.id} />
            </div>
          )
        })}

        {recent.length > 0 && (
          <>
            <div className="sidebar-header" style={{ padding: '12px 0 8px', borderBottom: 'none' }}>
              Recent
            </div>
            {recent.map(p => {
              const isImplementing = pipelineActive && (
                pipelineActive.proposalId === p.id || pipelineActive.capabilityId === p.capabilityId
              )
              const canRetry = !isImplementing && p.status !== 'verified' && p.status !== 'pending_approval' && p.status !== 'rejected'
              return (
                <div key={p.id} className="proposal-card" style={{ opacity: isImplementing ? 1 : 0.6 }}>
                  <div className="title">{p.title || p.capabilityId}</div>
                  <div className="meta">
                    <span className={`badge badge-${p.status}`}>{p.status}</span>
                    {' '}&middot; {p.capabilityId}
                  </div>
                  {isImplementing && <div className="implementing-bar" />}
                  {canRetry && (
                    <button
                      className="btn"
                      onClick={() => retryImplement(p.id)}
                      style={{ fontSize: 10, marginTop: 6, width: '100%' }}
                    >
                      Retry Implementation
                    </button>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
