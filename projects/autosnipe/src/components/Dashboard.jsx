import React from 'react'
import useSearches from '../hooks/useSearches'
import SearchCard from './SearchCard'

export default function Dashboard() {
  const { searches, toggleSearch, deleteSearch } = useSearches()

  const activeSearches = searches.filter(s => s.active)
  const parkedSearches = searches.filter(s => !s.active)

  return (
    <div className="page page-wide">
      <div className="dashboard-header">
        <h2>Active Searches</h2>
        <a href="#/new-search" className="btn btn-primary btn-sm">+ New</a>
      </div>
      {activeSearches.length === 0 ? (
        <div className="dashboard-empty">
          No active searches.
          <br />
          <a href="#/new-search">Create your first search</a> to start sniping.
        </div>
      ) : (
        activeSearches.map(s => (
          <SearchCard key={s.id} search={s} onToggle={toggleSearch} onDelete={deleteSearch} />
        ))
      )}

      {parkedSearches.length > 0 && (
        <>
          <div className="dashboard-header" style={{ marginTop: 32 }}>
            <h2>Parked</h2>
          </div>
          {parkedSearches.map(s => (
            <SearchCard key={s.id} search={s} onToggle={toggleSearch} onDelete={deleteSearch} />
          ))}
        </>
      )}
    </div>
  )
}
