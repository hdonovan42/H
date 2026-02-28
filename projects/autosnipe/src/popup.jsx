import React, { useState, useMemo, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import PreviewFrame from './components/PreviewFrame'
import './styles/autosnipe.css'

const ACCENT = '#FF6B00'
const TEXT_DIM = '#9090a8'
const FONT = "'IBM Plex Mono', monospace"

function ListingSummary({ listing }) {
  const specs = [
    listing.year,
    listing.mileage ? `${listing.mileage.toLocaleString()} miles` : null,
    listing.fuel_type,
    listing.transmission,
  ].filter(Boolean).join(' \u00b7 ')

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: 20, fontFamily: FONT, padding: 40, textAlign: 'center',
    }}>
      <div style={{ fontSize: 16, fontWeight: 600, color: '#f8f8ff', lineHeight: 1.5 }}>
        {listing.title || 'Untitled listing'}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: ACCENT }}>
        {listing.price ? `\u00a3${listing.price.toLocaleString()}` : 'Price on request'}
      </div>
      {specs && (
        <div style={{ fontSize: 12, color: TEXT_DIM }}>{specs}</div>
      )}
      {(listing.location || listing.seller_type) && (
        <div style={{ fontSize: 11, color: TEXT_DIM }}>
          {[listing.location, listing.seller_type].filter(Boolean).join(' \u00b7 ')}
        </div>
      )}
      <a
        href={listing.url}
        target="_self"
        style={{
          marginTop: 12, padding: '12px 28px', background: ACCENT, color: '#fff',
          borderRadius: 4, fontFamily: FONT, fontSize: 12, fontWeight: 600,
          textDecoration: 'none', letterSpacing: 0.5,
        }}
      >
        View on Autotrader
      </a>
    </div>
  )
}

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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: TEXT_DIM, fontFamily: FONT, fontSize: 13 }}>
          No listing data available.
        </div>
      </PreviewFrame>
    )
  }

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
      <ListingSummary listing={listing} />
    </PreviewFrame>
  )
}

ReactDOM.createRoot(document.getElementById('popup-root')).render(<PopupApp />)
