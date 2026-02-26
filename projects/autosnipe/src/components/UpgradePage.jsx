import React, { useState, useEffect } from 'react'
import { apiGet, apiPost } from '../utils/api'

export default function BuySlotPage({ user }) {
  const [currency, setCurrency] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    apiGet('/api/geo/currency').then(setCurrency).catch(() => {
      setCurrency({ currency: 'usd', symbol: '$' })
    })
  }, [])

  const handleBuy = async () => {
    setLoading(true)
    setError(null)
    try {
      const { url } = await apiPost('/api/stripe/checkout')
      window.location.href = url
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  const activeCount = user.active_searches || 0
  const maxSearches = user.max_searches || 1
  const slotsUsed = `${activeCount} / ${maxSearches}`
  const sym = currency?.symbol || '...'

  return (
    <div className="page">
      <div className="buy-slot">
        <h2>Buy Another Search Slot</h2>
        <p className="buy-slot-subtitle">
          You're using {slotsUsed} search slots.
          Each additional concurrent search costs just {sym}1 — one-off, no subscription.
        </p>

        <div className="buy-slot-card">
          <div className="buy-slot-price">
            {sym}1
            <span className="buy-slot-once">one-off</span>
          </div>
          <p className="buy-slot-desc">+1 concurrent search slot, yours forever</p>

          {error && <p className="error-msg">{error}</p>}

          <button
            className="btn btn-primary"
            onClick={handleBuy}
            disabled={loading || !currency}
            style={{ width: '100%', marginTop: 20 }}
          >
            {loading ? 'Redirecting to checkout...' : `Pay ${sym}1`}
          </button>
        </div>
      </div>
    </div>
  )
}
