import React, { useState, useMemo, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import PreviewFrame from './components/PreviewFrame'
import './styles/autosnipe.css'

const TEXT_DIM = '#9090a8'
const FONT = "'IBM Plex Mono', monospace"

function PopupApp() {
  const params = new URLSearchParams(window.location.search)
  const searchId = params.get('searchId')
  const startIndex = parseInt(params.get('index') || '0', 10)

  const listings = useMemo(() => {
    try {
      return JSON.parse(sessionStorage.getItem(`listings-${searchId}`) || '[]')
    } catch {
      return []
    }
  }, [searchId])

  const [current, setCurrent] = useState(startIndex)

  const listing = listings[current]

  // Navigate straight to Autotrader
  useEffect(() => {
    if (listing?.url) {
      window.location.href = listing.url
    }
  }, [listing?.url])

  if (!listing) {
    return (
      <PreviewFrame onClose={() => window.close()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: TEXT_DIM, fontFamily: FONT, fontSize: 13 }}>
          No listing data available.
        </div>
      </PreviewFrame>
    )
  }

  return null
}

ReactDOM.createRoot(document.getElementById('popup-root')).render(<PopupApp />)
