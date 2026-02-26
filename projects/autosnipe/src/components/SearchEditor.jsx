import React, { useState } from 'react'
import useSearches from '../hooks/useSearches'
import makesData from '../data/makes.json'
import modelsData from '../data/models.json'

const currentYear = new Date().getFullYear()
const years = Array.from({ length: 30 }, (_, i) => currentYear - i)

const formatNumber = (v) => {
  const raw = String(v).replace(/[^0-9]/g, '')
  return raw ? Number(raw).toLocaleString('en-GB') : ''
}
const parseNumber = (v) => String(v).replace(/,/g, '')

export default function SearchEditor() {
  const { createSearch } = useSearches()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const [form, setForm] = useState({
    name: '',
    make: '',
    model: '',
    variant: '',
    year_from: '',
    year_to: '',
    price_from: '',
    price_to: '',
    mileage_max: '',
    fuel_type: '',
    transmission: '',
    postcode: '',
    radius: '1500'
  })

  const NUMERIC_FIELDS = ['price_from', 'price_to', 'mileage_max']

  const set = (key) => (e) => {
    const val = e.target.value
    if (key === 'make') {
      setForm(f => ({ ...f, make: val, model: '', variant: '' }))
    } else if (key === 'model') {
      setForm(f => ({ ...f, model: val, variant: '' }))
    } else if (NUMERIC_FIELDS.includes(key)) {
      setForm(f => ({ ...f, [key]: formatNumber(val) }))
    } else {
      setForm(f => ({ ...f, [key]: val }))
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    setError(null)

    try {
      const criteria = {}
      if (form.make) criteria.make = form.make
      if (form.variant) {
        criteria.model = form.variant
        criteria.variant = form.variant
      } else if (form.model) {
        criteria.model = form.model
      }
      if (form.year_from) criteria.year_from = Number(form.year_from)
      if (form.year_to) criteria.year_to = Number(form.year_to)
      if (form.price_from) criteria.price_from = Number(parseNumber(form.price_from))
      if (form.price_to) criteria.price_to = Number(parseNumber(form.price_to))
      if (form.mileage_max) criteria.mileage_max = Number(parseNumber(form.mileage_max))
      if (form.fuel_type) criteria.fuel_type = form.fuel_type
      if (form.transmission) criteria.transmission = form.transmission
      if (form.postcode) {
        criteria.postcode = form.postcode
        if (form.radius) criteria.radius = Number(form.radius)
      }

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
              <select value={form.model} onChange={set('model')} disabled={!form.make}>
                <option value="">{form.make ? 'Any' : 'Select make'}</option>
                {(modelsData[form.make] || []).map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>

            {(() => {
              const selectedModel = (modelsData[form.make] || []).find(m => m.value === form.model)
              const variants = selectedModel?.variants || []
              return (
                <div className="input-group">
                  <label>Variant</label>
                  <select value={form.variant} onChange={set('variant')} disabled={!variants.length}>
                    <option value="">{variants.length ? 'Any' : 'Select model'}</option>
                    {variants.map(v => (
                      <option key={v.value} value={v.value}>{v.label}</option>
                    ))}
                  </select>
                </div>
              )
            })()}

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
                type="text"
                inputMode="numeric"
                placeholder="e.g. 5,000"
                value={form.price_from}
                onChange={set('price_from')}
              />
            </div>

            <div className="input-group">
              <label>Max Price (\u00a3)</label>
              <input
                type="text"
                inputMode="numeric"
                placeholder="e.g. 25,000"
                value={form.price_to}
                onChange={set('price_to')}
              />
            </div>

            <div className="input-group">
              <label>Max Mileage</label>
              <input
                type="text"
                inputMode="numeric"
                placeholder="e.g. 60,000"
                value={form.mileage_max}
                onChange={set('mileage_max')}
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
              <label>Distance</label>
              <select value={form.postcode ? form.radius : '1500'} onChange={set('radius')} disabled={!form.postcode}>
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
