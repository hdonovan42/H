import React from 'react'

function timeAgo(dateStr) {
  if (!dateStr) return 'Never'
  const diff = Date.now() - new Date(dateStr + 'Z').getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export default function SearchCard({ search, onDelete }) {
  const criteria = JSON.parse(search.criteria)

  const tags = [
    criteria.make,
    criteria.model,
    criteria.year_from && criteria.year_to
      ? `${criteria.year_from}-${criteria.year_to}`
      : criteria.year_from || criteria.year_to,
    criteria.price_from || criteria.price_to
      ? `\u00a3${(criteria.price_from || 0).toLocaleString()}-\u00a3${(criteria.price_to || '?').toLocaleString()}`
      : null,
    criteria.mileage_max ? `<${criteria.mileage_max.toLocaleString()}mi` : null,
    criteria.fuel_type,
    criteria.transmission,
    criteria.postcode ? `${criteria.postcode} (${criteria.radius || 50}mi)` : null
  ].filter(Boolean)

  return (
    <div className="search-card">
      <div className="search-card-header">
        <span className="search-card-name">
          {search.name || `${criteria.make || 'Any'} ${criteria.model || ''}`}
        </span>
        <span className={`search-card-status ${search.active ? 'active' : 'inactive'}`}>
          {search.active ? 'Active' : 'Paused'}
        </span>
      </div>

      <div className="search-card-criteria">
        {tags.map((tag, i) => (
          <span key={i} className="search-card-tag">{tag}</span>
        ))}
      </div>

      <div className="search-card-footer">
        <span>
          {search.total_listings || 0} listings found
          {' / '}
          Last checked: {timeAgo(search.last_checked)}
        </span>
        {search.active && (
          <button className="btn btn-danger btn-sm" onClick={() => onDelete(search.id)}>
            Remove
          </button>
        )}
      </div>
    </div>
  )
}
