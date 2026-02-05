import React, { useEffect, useRef } from 'react'
import { MessageType, UnitRank } from '../simulation/AgentSimulator'

function formatTimestamp(timestamp) {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function getRankClass(unitId, units) {
  const unit = units.get(unitId)
  if (!unit) return ''
  return unit.rank
}

function getMessageTypeIcon(type) {
  switch (type) {
    case MessageType.ORDER:
      return '📋'
    case MessageType.REPORT:
      return '📊'
    case MessageType.ALERT:
      return '⚠️'
    case MessageType.ESCALATE:
      return '🔺'
    case MessageType.INFO:
    default:
      return 'ℹ️'
  }
}

function getUnitDisplayName(unitId, units) {
  const unit = units.get(unitId)
  return unit?.name || unitId
}

export default function OperationsLog({ messages, units }) {
  const logEndRef = useRef(null)

  // Auto-scroll to latest message
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (messages.length === 0) {
    return (
      <div className="panel operations-panel">
        <div className="panel-header">
          <span className="panel-title">Operations Log</span>
        </div>
        <div className="panel-content">
          <div style={{
            textAlign: 'center',
            color: 'var(--parchment-dim)',
            padding: '2rem',
            fontStyle: 'italic'
          }}>
            Awaiting orders...
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel operations-panel">
      <div className="panel-header">
        <span className="panel-title">Operations Log</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--parchment-dim)' }}>
          {messages.length} message{messages.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="panel-content">
        {messages.map((message, index) => (
          <div
            key={message.id || index}
            className={`log-entry ${message.type} slide-in`}
            style={{ animationDelay: `${index * 0.05}s` }}
          >
            <div className="log-header">
              <div className="log-source">
                <span className={`log-rank ${getRankClass(message.sourceId, units)}`}>
                  {getUnitDisplayName(message.sourceId, units)}
                </span>
                <span>{getMessageTypeIcon(message.type)}</span>
              </div>
              <span className="log-timestamp">
                {formatTimestamp(message.timestamp)}
              </span>
            </div>
            <div className="log-message">{message.content}</div>
            {message.targetId && (
              <div className="log-target">
                → {getUnitDisplayName(message.targetId, units)}
              </div>
            )}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  )
}
