import React from 'react'

const NAV_LINKS = [
  { hash: '#/', label: 'Home' },
  { hash: '#/new-search', label: 'New Search' },
  { hash: '#/settings', label: 'Settings' },
]

export default function NavBar({ user, onLogout }) {
  const page = window.location.hash || '#/'

  return (
    <nav className="navbar">
      <a href="#/" className="navbar-brand">
        <span className="logo-icon">AS</span>
        AUTOSNIPE
      </a>
      <div className="navbar-links">
        {NAV_LINKS.map(l => (
          <a key={l.hash} href={l.hash} className={l.hash === '#/' ? (page === '#/' || page === '#' || page === '' ? 'active' : '') : page.startsWith(l.hash) ? 'active' : ''}>
            {l.label}
          </a>
        ))}
        <button onClick={() => { if (window.confirm('Are you sure you want to sign out?')) onLogout() }}>Sign Out</button>
      </div>
    </nav>
  )
}
