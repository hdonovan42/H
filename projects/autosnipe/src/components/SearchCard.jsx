import React, { useState, useEffect, useRef, useCallback } from 'react'
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

const ACCENT = '#FF6B00'
const BG_DARK = '#0a0a0f'
const TEXT_DIM = '#9090a8'

function ViewingBar({ listing, current, total, onPrev, onNext, onClose }) {
  return (
    <div className="viewing-bar">
      <div className="viewing-bar-header">
        <span className="viewing-bar-brand">AUTOSNIPE</span>
        <span className="viewing-bar-sep">{'\u2502'}</span>
        <span className="viewing-bar-title">{listing?.title || 'Listing'}</span>
        {listing?.price && (
          <span className="viewing-bar-price">
            {'\u00a3'}{listing.price.toLocaleString()}
          </span>
        )}
        <span className="viewing-bar-sep">{'\u2502'}</span>
        <span className="viewing-bar-close" onClick={onClose}>[ CLOSE ]</span>
      </div>
      <div className="viewing-bar-footer">
        <span
          className={`viewing-bar-nav ${current <= 0 ? 'dim' : ''}`}
          onClick={current > 0 ? onPrev : undefined}
        >{'\u2190'} Prev</span>
        <div className="viewing-bar-dots">
          {Array.from({ length: total || 0 }, (_, i) => (
            <span key={i} className={`viewing-bar-dot ${i === current ? 'active' : ''}`} />
          ))}
        </div>
        <span
          className={`viewing-bar-nav ${current >= total - 1 ? 'dim' : ''}`}
          onClick={current < total - 1 ? onNext : undefined}
        >Next {'\u2192'}</span>
      </div>
    </div>
  )
}

export default function SearchCard({ search, onToggle, onDelete }) {
  const [expanded, setExpanded] = useState(false)
  const [listings, setListings] = useState([])
  const [loadingListings, setLoadingListings] = useState(false)
  const [viewingIndex, setViewingIndex] = useState(null)
  const popupRef = useRef(null)

  const openListing = useCallback((index) => {
    const listing = listings[index]
    if (!listing?.url) return
    const features = `width=1000,height=${screen.availHeight},top=0,left=${screen.availWidth - 1000},scrollbars=yes`
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.location.href = listing.url
    } else {
      popupRef.current = window.open(listing.url, 'autotrader-preview', features)
    }
    setViewingIndex(index)
    // Keep dashboard in focus so viewing bar is visible
    setTimeout(() => window.focus(), 100)
  }, [listings])

  const closeViewing = useCallback(() => {
    if (popupRef.current && !popupRef.current.closed) popupRef.current.close()
    popupRef.current = null
    setViewingIndex(null)
  }, [])

  // Detect popup closed externally
  useEffect(() => {
    if (viewingIndex === null) return
    const check = setInterval(() => {
      if (popupRef.current?.closed) {
        popupRef.current = null
        setViewingIndex(null)
      }
    }, 500)
    return () => clearInterval(check)
  }, [viewingIndex])

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
          {viewingIndex !== null && (
            <ViewingBar
              listing={listings[viewingIndex]}
              current={viewingIndex}
              total={listings.length}
              onPrev={() => openListing(Math.max(0, viewingIndex - 1))}
              onNext={() => openListing(Math.min(listings.length - 1, viewingIndex + 1))}
              onClose={closeViewing}
            />
          )}
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
                className={`match-item ${i === viewingIndex ? 'match-item-active' : ''}`}
                onClick={() => openListing(i)}
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
