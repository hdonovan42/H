import React, { useState } from 'react'
import useSearches from '../hooks/useSearches'
import makesData from '../data/makes.json'

const currentYear = new Date().getFullYear()
const years = Array.from({ length: 30 }, (_, i) => currentYear - i)

export default function SearchEditor() {
  const { createSearch } = useSearches()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const [form, setForm] = useState({
    name: '',
    make: '',
    model: '',
    year_from: '',
    year_to: '',
    price_from: '',
    price_to: '',
    mileage_max: '',
    fuel_type: '',
    transmission: '',
    postcode: '',
    radius: '50'
  })

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    setError(null)

    try {
      const criteria = {}
      if (form.make) criteria.make = form.make
      if (form.model) criteria.model = form.model
      if (form.year_from) criteria.year_from = Number(form.year_from)
      if (form.year_to) criteria.year_to = Number(form.year_to)
      if (form.price_from) criteria.price_from = Number(form.price_from)
      if (form.price_to) criteria.price_to = Number(form.price_to)
      if (form.mileage_max) criteria.mileage_max = Number(form.mileage_max)
      if (form.fuel_type) criteria.fuel_type = form.fuel_type
      if (form.transmission) criteria.transmission = form.transmission
      if (form.postcode) criteria.postcode = form.postcode
      if (form.radius) criteria.radius = Number(form.radius)

      const name = form.name || `${form.make || 'Any'} ${form.model || ''}`.trim()
      await createSearch(name, criteria)
      window.location.hash = '#/dashboard'
    } catch (err) {
      if (err.message.includes('Buy another slot')) {
        setError(null)
        window.location.hash = '#/buy-slot'
        return
      }
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <div className="search-editor">
        <h2>New Search</h2>
        <form onSubmit={handleSubmit}>
          <div className="search-editor-grid">
            <div className="input-group full">
              <label>Search Name (optional)</label>
              <input
                type="text"
                placeholder="e.g. Weekend car"
                value={form.name}
                onChange={set('name')}
              />
            </div>

            <div className="input-group">
              <label>Make</label>
              <select value={form.make} onChange={set('make')}>
                <option value="">Any</option>
                {makesData.makes.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>

            <div className="input-group">
              <label>Model</label>
              <input
                type="text"
                placeholder="e.g. 3 Series"
                value={form.model}
                onChange={set('model')}
              />
            </div>

            <div className="input-group">
              <label>Year From</label>
              <select value={form.year_from} onChange={set('year_from')}>
                <option value="">Any</option>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>

            <div className="input-group">
              <label>Year To</label>
              <select value={form.year_to} onChange={set('year_to')}>
                <option value="">Any</option>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>

            <div className="input-group">
              <label>Min Price (\u00a3)</label>
              <input
                type="number"
                placeholder="e.g. 5000"
                value={form.price_from}
                onChange={set('price_from')}
                min="0"
              />
            </div>

            <div className="input-group">
              <label>Max Price (\u00a3)</label>
              <input
                type="number"
                placeholder="e.g. 25000"
                value={form.price_to}
                onChange={set('price_to')}
                min="0"
              />
            </div>

            <div className="input-group">
              <label>Max Mileage</label>
              <input
                type="number"
                placeholder="e.g. 60000"
                value={form.mileage_max}
                onChange={set('mileage_max')}
                min="0"
              />
            </div>

            <div className="input-group">
              <label>Fuel Type</label>
              <select value={form.fuel_type} onChange={set('fuel_type')}>
                <option value="">Any</option>
                {makesData.fuelTypes.map(f => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </div>

            <div className="input-group">
              <label>Transmission</label>
              <select value={form.transmission} onChange={set('transmission')}>
                <option value="">Any</option>
                {makesData.transmissions.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            <div className="input-group">
              <label>Postcode</label>
              <input
                type="text"
                placeholder="e.g. SW1A 1AA"
                value={form.postcode}
                onChange={set('postcode')}
              />
            </div>

            <div className="input-group">
              <label>Radius</label>
              <select value={form.radius} onChange={set('radius')}>
                {makesData.radiusOptions.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>

          {error && <p className="error-msg">{error}</p>}

          <div className="search-editor-actions">
            <a href="#/dashboard" className="btn btn-secondary">Cancel</a>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Creating...' : 'Create Search'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
