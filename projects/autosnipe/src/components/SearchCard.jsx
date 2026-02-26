import React, { useState, useEffect } from 'react'
import { apiGet } from '../utils/api'

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

export default function SearchCard({ search, onDelete, index = 0 }) {
  const [expanded, setExpanded] = useState(false)
  const [listings, setListings] = useState([])
  const [loadingListings, setLoadingListings] = useState(false)

  const criteria = JSON.parse(search.criteria)

  useEffect(() => {
    if (!expanded || listings.length > 0) return
    setLoadingListings(true)
    apiGet(`/api/searches/${search.id}/listings`)
      .then(data => setListings(data))
      .catch(err => console.error('Failed to fetch listings:', err))
      .finally(() => setLoadingListings(false))
  }, [expanded, search.id, listings.length])

  const tags = [
    criteria.make,
    criteria.model,
    criteria.variant,
    criteria.year_from && criteria.year_to
      ? `${criteria.year_from}\u2013${criteria.year_to}`
      : criteria.year_from || criteria.year_to,
    criteria.price_from || criteria.price_to
      ? `\u00a3${(criteria.price_from || 0).toLocaleString()}\u2013\u00a3${(criteria.price_to || '\u221e').toLocaleString()}`
      : null,
    criteria.mileage_max ? `< ${criteria.mileage_max.toLocaleString()} mi` : null,
    criteria.fuel_type,
    criteria.transmission,
    criteria.postcode ? `${criteria.postcode} (${criteria.radius || 50} mi)` : null
  ].filter(Boolean)

  const count = search.total_listings || 0

  return (
    <div className="search-card" style={{ '--i': index }}>
      <div className="search-card-header">
        <div className="search-card-header-left">
          <span className="search-card-name">
            {search.name || `${criteria.make || 'Any'} ${criteria.model || ''}`}
          </span>
          {search.active && (
            <span className="search-card-live">
              <span className="search-card-live-dot" />
              Live
            </span>
          )}
        </div>
        <div className="search-card-header-right">
          {search.active && (
            <button className="btn btn-danger btn-sm" onClick={() => onDelete(search.id)}>
              Remove
            </button>
          )}
        </div>
      </div>

      <div className="search-card-stats">
        <div className="search-card-stat">
          <span className="search-card-stat-value">{count}</span>
          <span className="search-card-stat-label">Listings</span>
        </div>
        <div className="search-card-stat">
          <span className="search-card-stat-value">{timeAgo(search.last_checked)}</span>
          <span className="search-card-stat-label">Last Scan</span>
        </div>
        <div className="search-card-stat">
          <span className="search-card-stat-value">{search.last_result_count || '\u2014'}</span>
          <span className="search-card-stat-label">Last Results</span>
        </div>
      </div>

      <div className="search-card-criteria">
        {tags.map((tag, i) => (
          <span key={i} className="search-card-tag">{tag}</span>
        ))}
      </div>

      <button
        className={`search-card-toggle ${expanded ? 'expanded' : ''}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="search-card-toggle-arrow">{'\u25B6'}</span>
        <span>{expanded ? 'Hide listings' : 'View listings'}</span>
      </button>

      {expanded && (
        <div className="search-card-listings">
          {loadingListings ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
              <span className="spinner" /> Loading listings...
            </div>
          ) : listings.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
              No listings yet. Results will appear after the next scan.
            </div>
          ) : (
            <div className="listing-grid">
              {listings.map((m, i) => (
                <a
                  key={m.id}
                  href={m.url || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="listing-card"
                  style={{ '--i': i }}
                >
                  <div className="listing-card-img">
                    {m.image_url && <img src={m.image_url} alt="" loading="lazy" />}
                  </div>
                  <div className="listing-card-body">
                    <div className="listing-card-price">
                      {m.price ? `\u00a3${m.price.toLocaleString()}` : 'POA'}
                    </div>
                    <div className="listing-card-title">{m.title || 'Untitled listing'}</div>
                    <div className="listing-card-specs">
                      {[
                        m.year,
                        m.mileage ? `${m.mileage.toLocaleString()} mi` : null,
                        m.fuel_type,
                        m.transmission
                      ].filter(Boolean).join(' \u00b7 ')}
                    </div>
                    <div className="listing-card-meta">
                      {[m.location, m.seller_type, timeAgo(m.first_seen)].filter(Boolean).join(' \u00b7 ')}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
