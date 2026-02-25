import React from 'react'
import useSearches from '../hooks/useSearches'
import useMatches from '../hooks/useMatches'
import SearchCard from './SearchCard'
import MatchFeed from './MatchFeed'

export default function Dashboard() {
  const { searches, deleteSearch } = useSearches()
  const { matches } = useMatches()

  const activeSearches = searches.filter(s => s.active)

  return (
    <div className="page">
      <div className="dashboard">
        <div className="dashboard-section">
          <h2>
            Active Searches
            <a href="#/new-search" className="btn btn-primary btn-sm">+ New</a>
          </h2>
          {activeSearches.length === 0 ? (
            <div className="dashboard-empty">
              No active searches.
              <br />
              <a href="#/new-search">Create your first search</a> to start sniping.
            </div>
          ) : (
            activeSearches.map(s => (
              <SearchCard key={s.id} search={s} onDelete={deleteSearch} />
            ))
          )}
        </div>

        <div className="dashboard-section">
          <h2>Recent Matches</h2>
          <MatchFeed matches={matches} />
        </div>
      </div>
    </div>
  )
}
