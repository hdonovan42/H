import React from 'react'
import useSearches from '../hooks/useSearches'
import SearchCard from './SearchCard'

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

export default function Dashboard() {
  const { searches, deleteSearch } = useSearches()

  const activeSearches = searches.filter(s => s.active)
  const totalListings = activeSearches.reduce((sum, s) => sum + (s.total_listings || 0), 0)
  const lastChecked = activeSearches
    .map(s => s.last_checked)
    .filter(Boolean)
    .sort()
    .pop()

  return (
    <div className="page page-wide">
      <div className="stats-bar">
        <div className="stat-card">
          <div className="stat-value">{activeSearches.length}</div>
          <div className="stat-label">Active Searches</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{totalListings}</div>
          <div className="stat-label">Listings Tracked</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{timeAgo(lastChecked)}</div>
          <div className="stat-label">Last Scan</div>
        </div>
      </div>

      <div className="dashboard-header">
        <h2>Active Searches</h2>
        <a href="#/new-search" className="btn btn-primary btn-sm">+ New Search</a>
      </div>

      {activeSearches.length === 0 ? (
        <div className="dashboard-empty">
          No active searches yet.
          <br />
          <a href="#/new-search">Create your first search</a> to start sniping.
        </div>
      ) : (
        activeSearches.map((s, i) => (
          <SearchCard key={s.id} search={s} onDelete={deleteSearch} index={i} />
        ))
      )}
    </div>
  )
}
