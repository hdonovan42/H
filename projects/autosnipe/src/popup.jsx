import React, { useState, useMemo } from 'react'
import ReactDOM from 'react-dom/client'
import PreviewFrame from './components/PreviewFrame'
import './styles/autosnipe.css'

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
  if (!listing) {
    return (
      <PreviewFrame onClose={() => window.close()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9090a8', fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }}>
          No listing data available.
        </div>
      </PreviewFrame>
    )
  }

  const proxyUrl = `/api/frame?url=${encodeURIComponent(listing.url)}`
  const onPrev = () => setCurrent(i => Math.max(0, i - 1))
  const onNext = () => setCurrent(i => Math.min(listings.length - 1, i + 1))

  return (
    <PreviewFrame
      url={listing.url}
      price={listing.price}
      current={current}
      total={listings.length}
      onPrev={onPrev}
      onNext={onNext}
      onClose={() => window.close()}
    >
      <iframe
        src={proxyUrl}
        style={{ width: '100%', height: '100%', border: 'none' }}
        title={listing.title || 'Listing preview'}
      />
    </PreviewFrame>
  )
}

ReactDOM.createRoot(document.getElementById('popup-root')).render(<PopupApp />)
