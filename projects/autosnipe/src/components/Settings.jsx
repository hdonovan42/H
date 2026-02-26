import React, { useState } from 'react'
import { apiPatch, apiGet } from '../utils/api'

export default function Settings({ user, onRefresh }) {
  const [phone, setPhone] = useState(user.phone || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleSave = async (e) => {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    try {
      await apiPatch('/api/settings', { phone: phone.trim() || null })
      setSaved(true)
      if (onRefresh) onRefresh()
    } catch (err) {
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const handleManageSubscription = async () => {
    try {
      const { url } = await apiGet('/api/stripe/portal')
      window.location.href = url
    } catch (err) {
      console.error(err)
    }
  }

  const active = user.active_searches || 0
  const max = user.max_searches || 1
  const paidSlots = user.paid_slots || 0

  return (
    <div className="page">
      <div className="settings">
        <h2>Settings</h2>

        <div className="settings-section">
          <h3>Account</h3>
          <div className="input-group" style={{ marginBottom: 12 }}>
            <label>Email</label>
            <input type="text" value={user.email} disabled style={{ opacity: 0.5 }} />
          </div>
          <div className="input-group">
            <label>Search Slots</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="navbar-slots">{active}/{max} used</span>
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                (1 free{paidSlots > 0 ? ` + ${paidSlots} subscribed` : ''})
              </span>
              <a href="#/buy-slot" className="btn btn-primary btn-sm">
                {user.has_subscription ? 'Add Slot' : 'Subscribe'}
              </a>
            </div>
            {user.has_subscription && (
              <button
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 8 }}
                onClick={handleManageSubscription}
              >
                Manage Subscription
              </button>
            )}
          </div>
        </div>

        <div className="settings-section">
          <h3>WhatsApp Notifications</h3>
          <form onSubmit={handleSave}>
            <div className="input-group" style={{ marginBottom: 12 }}>
              <label>Phone Number (with country code)</label>
              <input
                type="tel"
                placeholder="+447700000000"
                value={phone}
                onChange={e => setPhone(e.target.value)}
              />
            </div>
            <button className="btn btn-primary btn-sm" disabled={saving}>
              {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
