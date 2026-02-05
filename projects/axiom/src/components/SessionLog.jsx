import React, { useEffect, useRef, memo } from 'react'
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
      return '>'
    case MessageType.REPORT:
      return '<'
    case MessageType.ALERT:
      return '!'
    case MessageType.ESCALATE:
      return '^'
    case MessageType.INFO:
    default:
      return '-'
  }
}

function getUnitDisplayName(unitId, units) {
  const unit = units.get(unitId)
  return unit?.name || unitId
}

const LogEntry = memo(function LogEntry({ message, index, units }) {
  return (
    <div
      className={`log-entry ${message.type}${message.streaming ? ' streaming' : ''} slide-in`}
      style={{ animationDelay: `${Math.min(index * 0.05, 1)}s` }}
    >
      <div className="log-header">
        <div className="log-source">
          <span className={`log-rank ${getRankClass(message.sourceId, units)}`}>
            {getUnitDisplayName(message.sourceId, units)}
          </span>
          <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{getMessageTypeIcon(message.type)}</span>
        </div>
        <span className="log-timestamp">
          {formatTimestamp(message.timestamp)}
        </span>
      </div>
      <div className="log-message">
        {message.content}
        {message.streaming && <span className="streaming-cursor">|</span>}
      </div>
      {message.targetId && (
        <div className="log-target">
          {'>'} {getUnitDisplayName(message.targetId, units)}
        </div>
      )}
    </div>
  )
})

export default function SessionLog({ messages, units, embedded }) {
  const logEndRef = useRef(null)

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (messages.length === 0 && embedded) {
    return (
      <div style={{
        textAlign: 'center',
        color: 'var(--text-dim)',
        padding: '2rem',
        fontStyle: 'italic'
      }}>
        Awaiting session...
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="panel log-panel">
        <div className="panel-header">
          <span className="panel-title">Session Log</span>
        </div>
        <div className="panel-content">
          <div style={{
            textAlign: 'center',
            color: 'var(--text-dim)',
            padding: '2rem',
            fontStyle: 'italic'
          }}>
            Awaiting session...
          </div>
        </div>
      </div>
    )
  }

  const logContent = (
    <>
      {messages.map((message, index) => (
        <LogEntry
          key={message.id || index}
          message={message}
          index={index}
          units={units}
        />
      ))}
      <div ref={logEndRef} />
    </>
  )

  if (embedded) return logContent

  return (
    <div className="panel log-panel">
      <div className="panel-header">
        <span className="panel-title">Session Log</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
          {messages.length} message{messages.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="panel-content">
        {logContent}
      </div>
    </div>
  )
}
