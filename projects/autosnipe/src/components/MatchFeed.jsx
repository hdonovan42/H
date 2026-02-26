import React from 'react'

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr + 'Z').getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export default function MatchFeed({ matches }) {
  if (!matches.length) {
    return (
      <div className="dashboard-empty">
        No matches yet. Results will appear here after the next scan.
      </div>
    )
  }

  return (
    <div>
      {matches.map(m => (
        <a
          key={m.id}
          href={m.url || '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="match-item"
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          <div className="match-info">
            <div className="match-title">{m.title || 'Untitled listing'}</div>
            <div className="match-price">
              {m.price ? `\u00a3${m.price.toLocaleString()}` : 'Price on request'}
            </div>
            <div className="match-specs">
              {[
                m.year,
                m.mileage ? `${m.mileage.toLocaleString()} miles` : null,
                m.fuel_type,
                m.transmission
              ].filter(Boolean).join(' \u00b7 ')}
            </div>
            <div className="match-meta">
              {m.location && `${m.location} \u00b7 `}
              {m.seller_type && `${m.seller_type} \u00b7 `}
              {timeAgo(m.first_seen)}
            </div>
          </div>
        </a>
      ))}
    </div>
  )
}
