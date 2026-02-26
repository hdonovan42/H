import React, { useState } from 'react'
import { apiPost } from '../utils/api'

const CURRENCIES = [
  { code: 'gbp', symbol: '£', label: 'GBP (£)' },
  { code: 'usd', symbol: '$', label: 'USD ($)' },
  { code: 'eur', symbol: '€', label: 'EUR (€)' }
]

export default function BuySlotPage({ user }) {
  const [currency, setCurrency] = useState('gbp')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const selected = CURRENCIES.find(c => c.code === currency)

  const handleBuy = async () => {
    setLoading(true)
    setError(null)
    try {
      const { url } = await apiPost('/api/stripe/checkout', { currency })
      window.location.href = url
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  const activeCount = user.active_searches || 0
  const maxSearches = user.max_searches || 1
  const slotsUsed = `${activeCount} / ${maxSearches}`

  return (
    <div className="page">
      <div className="buy-slot">
        <h2>Buy Another Search Slot</h2>
        <p className="buy-slot-subtitle">
          You're using {slotsUsed} search slots.
          Each additional concurrent search costs just {selected.symbol}1 — one-off, no subscription.
        </p>

        <div className="buy-slot-card">
          <div className="buy-slot-price">
            {selected.symbol}1
            <span className="buy-slot-once">one-off</span>
          </div>
          <p className="buy-slot-desc">+1 concurrent search slot, yours forever</p>

          <div className="buy-slot-currency">
            <label>Currency</label>
            <div className="buy-slot-options">
              {CURRENCIES.map(c => (
                <button
                  key={c.code}
                  className={`buy-slot-option ${currency === c.code ? 'active' : ''}`}
                  onClick={() => setCurrency(c.code)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="error-msg">{error}</p>}

          <button
            className="btn btn-primary"
            onClick={handleBuy}
            disabled={loading}
            style={{ width: '100%', marginTop: 20 }}
          >
            {loading ? 'Redirecting to checkout...' : `Pay ${selected.symbol}1`}
          </button>
        </div>
      </div>
    </div>
  )
}
