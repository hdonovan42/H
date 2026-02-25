import React, { useState } from 'react'
import { apiPatch } from '../utils/api'

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
            <label>Tier</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className={`navbar-tier ${user.tier}`}>{user.tier}</span>
              {user.tier === 'free' && (
                <a href="#/upgrade" className="btn btn-primary btn-sm">Upgrade</a>
              )}
            </div>
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
