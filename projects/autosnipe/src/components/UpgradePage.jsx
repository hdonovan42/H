import React, { useState } from 'react'
import { apiPost } from '../utils/api'

export default function UpgradePage({ user }) {
  const [loading, setLoading] = useState(false)

  const handleUpgrade = async () => {
    setLoading(true)
    try {
      const { url } = await apiPost('/api/stripe/checkout')
      window.location.href = url
    } catch (err) {
      console.error(err)
      setLoading(false)
    }
  }

  if (user.tier === 'pro') {
    return (
      <div className="page">
        <div className="upgrade">
          <h2>You're on Pro</h2>
          <p className="upgrade-subtitle">
            You have access to up to 10 active searches. Enjoy sniping.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="upgrade">
        <h2>Upgrade to Pro</h2>
        <p className="upgrade-subtitle">
          Unlock more active searches and never miss a deal.
        </p>

        <div className="upgrade-tiers">
          <div className="upgrade-tier">
            <h3>Free</h3>
            <div className="upgrade-price">&pound;0<span> / month</span></div>
            <ul className="upgrade-features">
              <li>1 active search</li>
              <li>WhatsApp alerts</li>
              <li>Scans every 3 hours</li>
            </ul>
          </div>

          <div className="upgrade-tier pro">
            <h3>Pro</h3>
            <div className="upgrade-price">&pound;9.99<span> / month</span></div>
            <ul className="upgrade-features">
              <li>10 active searches</li>
              <li>WhatsApp alerts</li>
              <li>Scans every 3 hours</li>
              <li>Priority support</li>
            </ul>
            <button
              className="btn btn-primary"
              onClick={handleUpgrade}
              disabled={loading}
              style={{ width: '100%', marginTop: 20 }}
            >
              {loading ? 'Redirecting...' : 'Upgrade Now'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
