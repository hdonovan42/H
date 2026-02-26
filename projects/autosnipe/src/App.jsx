import React, { useState, useEffect } from 'react'
import useAuth from './hooks/useAuth'
import NavBar from './components/NavBar'
import Landing from './components/Landing'
import Dashboard from './components/Dashboard'
import SearchEditor from './components/SearchEditor'
import Settings from './components/Settings'
import BuySlotPage from './components/UpgradePage'

export default function App() {
  const [page, setPage] = useState(window.location.hash || '#/')
  const { user, loading, login, logout, refresh } = useAuth()

  useEffect(() => {
    const handler = () => setPage(window.location.hash || '#/')
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  // Handle auth callback from magic link
  useEffect(() => {
    if (page.startsWith('#/auth-callback')) {
      const params = new URLSearchParams(page.split('?')[1])
      const t = params.get('token')
      if (t) {
        login(t)
        window.location.hash = '#/dashboard'
      }
    }
  }, [page, login])

  if (loading) {
    return <div className="loading"><span className="spinner" /> Loading...</div>
  }

  if (!user) return <Landing />

  const renderPage = () => {
    if (page.startsWith('#/new-search')) return <SearchEditor />
    if (page.startsWith('#/settings')) return <Settings user={user} onRefresh={refresh} />
    if (page.startsWith('#/buy-slot')) return <BuySlotPage user={user} onRefresh={refresh} />
    return <Dashboard />
  }

  return (
    <div className="app">
      <NavBar user={user} onLogout={logout} />
      {renderPage()}
    </div>
  )
}
