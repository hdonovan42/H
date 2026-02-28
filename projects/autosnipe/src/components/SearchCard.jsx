import React, { useState, useEffect } from 'react'
import { apiGet } from '../utils/api'
import { navigate } from '../App'

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

export default function SearchCard({ search, onToggle, onDelete }) {
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

  const autoNames = new Set([
    `${criteria.make || 'Any'} ${criteria.model || ''}`.trim(),
    `${criteria.make || 'Any'} ${criteria.model || ''} ${criteria.variant || ''}`.trim(),
  ])
  const hasNickname = search.name && !autoNames.has(search.name)

  const tags = [
    ...(hasNickname ? [criteria.make, criteria.model, criteria.variant] : []),
    criteria.year_from && criteria.year_to
      ? `${criteria.year_from}-${criteria.year_to}`
      : criteria.year_from || criteria.year_to,
    criteria.price_from || criteria.price_to
      ? `£${(criteria.price_from || 0).toLocaleString()}-£${(criteria.price_to || '?').toLocaleString()}`
      : null,
    criteria.mileage_max ? `<${criteria.mileage_max.toLocaleString()}mi` : null,
    criteria.fuel_type,
    criteria.transmission,
    criteria.colour,
    criteria.doors ? `${criteria.body_type} ${criteria.doors}dr` : criteria.body_type,
    criteria.exclude_cat === false ? 'Incl. CAT' : null,
    criteria.postcode ? `${criteria.postcode} (${criteria.radius || 50}mi)` : null
  ].filter(Boolean)

  const count = search.total_listings || 0

  return (
    <div className="search-card">
      <div className="search-card-actions">
        {search.active ? (
          <>
            <span className="search-card-status active">Active</span>
            <button className="btn btn-secondary btn-sm" onClick={() => { navigate(`/edit-search/${search.id}`) }}>
              Edit
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => onToggle(search.id, false)}>
              Park
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-secondary btn-sm" onClick={() => onToggle(search.id, true)}>
              Unpark
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => { navigate(`/edit-search/${search.id}`) }}>
              Edit
            </button>
            <button className="btn btn-danger btn-sm" onClick={() => { if (confirm('Delete this search? This cannot be undone.')) onDelete(search.id) }}>
              Delete
            </button>
          </>
        )}
      </div>
      <div className="search-card-header">
        <span className="search-card-name">
          {hasNickname ? search.name : `${criteria.make || 'Any'} ${criteria.model || ''} ${criteria.variant || ''}`.trim()}
        </span>
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
        <span className="search-card-toggle-arrow">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span>
          {count} listing{count !== 1 ? 's' : ''} found
          <span className="search-card-toggle-sep">/</span>
          Last checked: {timeAgo(search.last_checked)}
        </span>
      </button>

      {expanded && (
        <div className="search-card-listings">
          {loadingListings ? (
            <div className="search-card-listings-loading">
              <span className="spinner" /> Loading listings...
            </div>
          ) : listings.length === 0 ? (
            <div className="search-card-listings-empty">
              No listings yet. Results will appear after the next scan.
            </div>
          ) : (
            listings.map((m, i) => (
              <div
                key={m.id}
                className="match-item"
                onClick={() => m.url && window.open(m.url, 'autotrader-preview', `width=1000,height=${screen.availHeight},top=0,left=${screen.availWidth - 1000},scrollbars=yes`)}
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
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
