import React from 'react'

const ACCENT = '#FF6B00'
const BG_DARK = '#0a0a0f'
const TEXT_DIM = '#9090a8'
const FONT = "'IBM Plex Mono', monospace"

export default function ListingNav({ listing, current, total, onPrev, onNext, onClose }) {
  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9999,
      background: BG_DARK,
      borderTop: `1px solid ${ACCENT}33`,
      boxShadow: `0 -4px 20px ${ACCENT}0a`,
      fontFamily: FONT,
    }}>
      {/* Header row */}
      <div style={{
        padding: '6px 16px',
        display: 'flex', alignItems: 'center', gap: 10,
        fontSize: 9, borderBottom: `1px solid ${ACCENT}1a`,
      }}>
        <span style={{ color: ACCENT, fontWeight: 700, letterSpacing: 2 }}>AUTOSNIPE</span>
        <span style={{ color: `${ACCENT}44` }}>{'\u2502'}</span>
        <span style={{ color: '#f8f8ff', fontSize: 11, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {listing?.title || 'Listing'}
        </span>
        {listing?.price && (
          <span style={{ color: ACCENT, fontWeight: 700, fontSize: 11 }}>
            {'\u00a3'}{listing.price.toLocaleString()}
          </span>
        )}
        <span style={{ color: `${ACCENT}44` }}>{'\u2502'}</span>
        <span onClick={onClose} style={{ color: TEXT_DIM, cursor: 'pointer', userSelect: 'none' }}>[ CLOSE ]</span>
      </div>

      {/* Footer row */}
      <div style={{
        padding: '5px 16px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 9,
        background: `linear-gradient(180deg, ${BG_DARK}, #161620)`,
      }}>
        <span onClick={onPrev} style={{ color: current > 0 ? TEXT_DIM : `${TEXT_DIM}44`, cursor: current > 0 ? 'pointer' : 'default', userSelect: 'none' }}>{'\u2190'} Prev</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {Array.from({ length: total || 0 }, (_, i) => (
            <div key={i} style={{
              width: 5, height: 5, borderRadius: '50%',
              background: i === current ? ACCENT : `${TEXT_DIM}44`,
            }} />
          ))}
        </div>
        <span onClick={onNext} style={{ color: current < total - 1 ? TEXT_DIM : `${TEXT_DIM}44`, cursor: current < total - 1 ? 'pointer' : 'default', userSelect: 'none' }}>Next {'\u2192'}</span>
      </div>
    </div>
  )
}
