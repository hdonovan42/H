import React, { useState } from 'react'
import { apiPost } from '../utils/api'

export default function Landing() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [devLink, setDevLink] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!email.trim()) return
    setLoading(true)
    setError(null)

    try {
      const result = await apiPost('/api/auth/magic-link', { email: email.trim() })
      setSent(true)
      if (result.dev_link) setDevLink(result.dev_link)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="landing">
      <div className="landing-logo">AUTOSNIPE</div>
      <p className="landing-tagline">
        Set your criteria. We watch Autotrader around the clock.
        New matches land straight in your WhatsApp.
      </p>

      {sent ? (
        <div>
          <p className="landing-sent">
            {devLink ? 'Dev mode — click below to sign in:' : 'Check your email for a sign-in link.'}
          </p>
          {devLink && (
            <a href={devLink} className="btn btn-primary" style={{ marginTop: 16, display: 'inline-block' }}>
              Sign In
            </a>
          )}
        </div>
      ) : (
        <form className="landing-form" onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoFocus
          />
          <button className="btn btn-primary" disabled={loading}>
            {loading ? 'Sending...' : 'Get Started'}
          </button>
          {error && <p className="error-msg">{error}</p>}
        </form>
      )}

      <div className="landing-features">
        <div className="landing-feature">
          <div className="landing-feature-icon">//</div>
          <h3>Set Criteria</h3>
          <p>Make, model, price range, mileage, fuel type, location — your call.</p>
        </div>
        <div className="landing-feature">
          <div className="landing-feature-icon">{'>>'}</div>
          <h3>AI Monitors</h3>
          <p>Computer vision scans Autotrader every few hours, like a human would.</p>
        </div>
        <div className="landing-feature">
          <div className="landing-feature-icon">{'<!'}</div>
          <h3>Instant Alerts</h3>
          <p>New matches hit your WhatsApp the moment they appear.</p>
        </div>
      </div>
    </div>
  )
}
