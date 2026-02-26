import React, { useState } from 'react'
import { apiGet, apiPost } from '../utils/api'

export default function BuySlotPage({ user, onRefresh }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(false)

  const handleBuy = async () => {
    setLoading(true)
    setError(null)
    setSuccess(false)
    try {
      const result = await apiPost('/api/stripe/checkout')
      if (result.url) {
        window.location.href = result.url
      } else if (result.added) {
        setSuccess(true)
        setLoading(false)
        if (onRefresh) onRefresh()
      }
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  const handleManage = async () => {
    try {
      const { url } = await apiGet('/api/stripe/portal')
      window.location.href = url
    } catch (err) {
      setError(err.message)
    }
  }

  const activeCount = user.active_searches || 0
  const maxSearches = user.max_searches || 1
  const slotsUsed = `${activeCount} / ${maxSearches}`
  const hasSub = user.has_subscription

  return (
    <div className="page">
      <div className="buy-slot">
        <h2>{hasSub ? 'Add Another Search Slot' : 'Subscribe for More Searches'}</h2>
        <p className="buy-slot-subtitle">
          You're using {slotsUsed} search slots.
          Each additional concurrent search costs just £1/mo.
        </p>

        <div className="buy-slot-card">
          <div className="buy-slot-price">
            £1
            <span className="buy-slot-once">/month per slot</span>
          </div>
          <p className="buy-slot-desc">
            {hasSub
              ? '+1 concurrent search slot, added to your subscription'
              : '+1 concurrent search slot, cancel any time'}
          </p>

          {error && <p className="error-msg">{error}</p>}
          {success && <p className="success-msg">Slot added!</p>}

          <button
            className="btn btn-primary"
            onClick={handleBuy}
            disabled={loading}
            style={{ width: '100%', marginTop: 20 }}
          >
            {loading
              ? (hasSub ? 'Adding slot...' : 'Redirecting to checkout...')
              : (hasSub ? 'Add slot — £1/mo' : 'Subscribe — £1/mo')}
          </button>

          {hasSub && (
            <button
              className="btn btn-secondary"
              onClick={handleManage}
              style={{ width: '100%', marginTop: 12 }}
            >
              Manage Subscription
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
