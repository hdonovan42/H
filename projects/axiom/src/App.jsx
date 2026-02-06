import React, { useState, useEffect } from 'react'
import AxiomDashboard from './components/AxiomDashboard'
import AxiomShell from './components/AxiomShell'

export default function App() {
  const [page, setPage] = useState(window.location.hash)

  useEffect(() => {
    const handler = () => setPage(window.location.hash)
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  return (
    <div className="app">
      {page === '#/shell' ? <AxiomShell /> : <AxiomDashboard />}
    </div>
  )
}
