import React from 'react'

const NAV_LINKS = [
  { hash: '#/dashboard', label: 'Dashboard' },
  { hash: '#/new-search', label: 'New Search' },
  { hash: '#/settings', label: 'Settings' },
]

export default function NavBar({ user, onLogout }) {
  const page = window.location.hash || '#/dashboard'

  return (
    <nav className="navbar">
      <a href="#/dashboard" className="navbar-brand">
        <span className="logo-icon">AS</span>
        AUTOSNIPE
      </a>
      <div className="navbar-links">
        {NAV_LINKS.map(l => (
          <a key={l.hash} href={l.hash} className={page.startsWith(l.hash) ? 'active' : ''}>
            {l.label}
          </a>
        ))}
        <button onClick={onLogout}>Sign Out</button>
      </div>
    </nav>
  )
}
