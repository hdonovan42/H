import React, { useState, useEffect } from 'react'
import ValuesDashboard from './components/ValuesDashboard'
import Shell from './components/Shell'
import PipelineView from './components/PipelineView'
import VerificationLog from './components/VerificationLog'

export default function App() {
  const [page, setPage] = useState(window.location.hash)

  useEffect(() => {
    const handler = () => setPage(window.location.hash)
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  const renderPage = () => {
    switch (page) {
      case '#/shell': return <Shell />
      case '#/pipeline': return <PipelineView />
      case '#/log': return <VerificationLog />
      default: return <ValuesDashboard />
    }
  }

  return (
    <div className="app">
      {renderPage()}
    </div>
  )
}
