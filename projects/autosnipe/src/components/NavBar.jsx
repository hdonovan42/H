import React from 'react'
import { navigate } from '../App'

const NAV_LINKS = [
  { path: '/', label: 'Home' },
  { path: '/new-search', label: 'New Search' },
  { path: '/settings', label: 'Settings' },
]

export default function NavBar({ user, onLogout }) {
  const current = window.location.pathname

  const handleClick = (e, path) => {
    e.preventDefault()
    navigate(path)
  }

  const isActive = (link) => {
    if (link === '/') return current === '/'
    return current.startsWith(link)
  }

  return (
    <nav className="navbar">
      <a href="/" className="navbar-brand" onClick={e => handleClick(e, '/')}>
        <span className="logo-icon">AS</span>
        AUTOSNIPE
      </a>
      <div className="navbar-links">
        {NAV_LINKS.map(l => (
          <a key={l.path} href={l.path} onClick={e => handleClick(e, l.path)} className={isActive(l.path) ? 'active' : ''}>
            {l.label}
          </a>
        ))}
        <button onClick={() => { if (window.confirm('Are you sure you want to sign out?')) onLogout() }}>Sign Out</button>
      </div>
    </nav>
  )
}
