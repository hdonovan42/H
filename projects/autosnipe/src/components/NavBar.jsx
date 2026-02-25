import React from 'react'

export default function NavBar({ user, onLogout }) {
  return (
    <nav className="navbar">
      <a href="#/dashboard" className="navbar-brand">
        <span className="logo-icon">AS</span>
        AUTOSNIPE
      </a>
      <div className="navbar-links">
        <a href="#/dashboard">Dashboard</a>
        <a href="#/new-search">New Search</a>
        <a href="#/settings">Settings</a>
        <span className={`navbar-tier ${user.tier}`}>{user.tier}</span>
        <button onClick={onLogout}>Sign Out</button>
      </div>
    </nav>
  )
}
