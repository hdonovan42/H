import React, { useState, useEffect } from 'react'
import useAuth from './hooks/useAuth'
import NavBar from './components/NavBar'
import Landing from './components/Landing'
import Dashboard from './components/Dashboard'
import SearchEditor from './components/SearchEditor'
import Settings from './components/Settings'
import BuySlotPage from './components/UpgradePage'

export function navigate(path) {
  window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export default function App() {
  const [path, setPath] = useState(window.location.pathname)
  const { user, loading, login, logout, refresh } = useAuth()

  useEffect(() => {
    const handler = () => setPath(window.location.pathname)
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  // Handle auth callback from magic link
  useEffect(() => {
    if (path === '/auth-callback') {
      const params = new URLSearchParams(window.location.search)
      const t = params.get('token')
      if (t) {
        login(t)
        navigate('/')
      }
    }
  }, [path, login])

  // Redirect legacy hash routes
  useEffect(() => {
    const hash = window.location.hash
    if (hash && hash.startsWith('#/')) {
      const newPath = hash.slice(1)
      navigate(newPath)
    }
  }, [])

  if (loading) {
    return <div className="loading"><span className="spinner" /> Loading...</div>
  }

  if (!user) return <Landing />

  const renderPage = () => {
    if (path.startsWith('/edit-search/')) {
      const id = path.split('/').pop()
      return <SearchEditor editId={id} />
    }
    if (path.startsWith('/new-search')) return <SearchEditor />
    if (path.startsWith('/settings')) return <Settings user={user} onRefresh={refresh} />
    if (path.startsWith('/buy-slot')) return <BuySlotPage user={user} onRefresh={refresh} />
    return <Dashboard />
  }

  return (
    <div className="app">
      <NavBar user={user} onLogout={logout} />
      {renderPage()}
    </div>
  )
}
