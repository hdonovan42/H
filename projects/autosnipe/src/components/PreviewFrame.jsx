import React from 'react'

const ACCENT = '#FF6B00'
const BG_DARK = '#0a0a0f'
const TEXT_DIM = '#9090a8'
const FONT = "'IBM Plex Mono', monospace"

export default function PreviewFrame({ url, price, current, total, onPrev, onNext, onClose, children }) {
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      background: BG_DARK, borderRadius: 6, overflow: 'hidden',
      border: `1px solid ${ACCENT}33`,
      boxShadow: `inset 0 0 40px ${ACCENT}08, 0 0 20px ${ACCENT}0a`,
    }}>
      {/* Header */}
      <div style={{
        padding: '6px 12px', borderBottom: `1px solid ${ACCENT}33`,
        display: 'flex', alignItems: 'center', gap: 10,
        fontFamily: FONT, fontSize: 9,
      }}>
        <span style={{ color: ACCENT, fontWeight: 700, letterSpacing: 2 }}>AUTOSNIPE</span>
        <span style={{ color: `${ACCENT}44` }}>│</span>
        <span style={{ color: TEXT_DIM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {url || 'autotrader.co.uk/car-details/...'}
        </span>
        {price && (
          <span style={{ color: ACCENT, fontWeight: 700, fontSize: 10 }}>
            £{typeof price === 'number' ? price.toLocaleString() : price}
          </span>
        )}
        <span style={{ color: `${ACCENT}44` }}>│</span>
        <span onClick={onClose} style={{ color: TEXT_DIM, cursor: 'pointer' }}>[ CLOSE ]</span>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>{children}</div>

      {/* Footer */}
      <div style={{
        padding: '5px 12px', borderTop: `1px solid ${ACCENT}33`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontFamily: FONT, fontSize: 9,
        background: `linear-gradient(180deg, ${BG_DARK}, #161620)`,
      }}>
        <span onClick={onPrev} style={{ color: TEXT_DIM, cursor: 'pointer' }}>← Prev</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {Array.from({ length: total || 0 }, (_, i) => (
            <div key={i} style={{
              width: 5, height: 5, borderRadius: '50%',
              background: i === (current || 0) ? ACCENT : `${TEXT_DIM}44`,
            }} />
          ))}
        </div>
        <span onClick={onNext} style={{ color: TEXT_DIM, cursor: 'pointer' }}>Next →</span>
      </div>
    </div>
  )
}
