import React, { useState, useEffect, useRef } from 'react'
import useSearches from '../hooks/useSearches'
import { apiPost } from '../utils/api'
import { navigate } from '../App'
import makesData from '../data/makes.json'

const currentYear = new Date().getFullYear()
const years = Array.from({ length: 30 }, (_, i) => currentYear - i)

const formatNumber = (v) => {
  const raw = String(v).replace(/[^0-9]/g, '')
  return raw ? Number(raw).toLocaleString('en-GB') : ''
}
const parseNumber = (v) => String(v).replace(/,/g, '')

export default function SearchEditor({ editId }) {
  const { searches, createSearch, updateSearch } = useSearches()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [taxonomy, setTaxonomy] = useState(null)
  const [taxonomyLoading, setTaxonomyLoading] = useState(true)
  const draftKey = `autosnipe-draft:${editId || 'new'}`
  const savedDraft = (() => {
    try { return JSON.parse(localStorage.getItem(draftKey)) } catch { return null }
  })()

  const [loaded, setLoaded] = useState(!!savedDraft)

  useEffect(() => {
    fetch('/api/taxonomy')
      .then(r => r.ok ? r.json() : null)
      .then(data => setTaxonomy(data))
      .catch(() => {})
      .finally(() => setTaxonomyLoading(false))
  }, [])

  const defaults = {
    name: '',
    make: '',
    model: '',
    variant: '',
    year_from: '',
    year_to: '',
    colour: '',
    price_from: '',
    price_to: '',
    mileage_max: '',
    fuel_type: '',
    transmission: '',
    body_type: '',
    exclude_cat: true,
    postcode: '',
    radius: '1500'
  }

  const [form, setForm] = useState(savedDraft || defaults)

  // Persist draft to localStorage on every change
  useEffect(() => {
    localStorage.setItem(draftKey, JSON.stringify(form))
  }, [form, draftKey])

  useEffect(() => {
    if (!editId || loaded || !searches.length) return
    const search = searches.find(s => String(s.id) === String(editId))
    if (!search) return
    const c = JSON.parse(search.criteria)
    setForm({
      name: search.name || '',
      make: c.make || '',
      model: c.model || '',
      variant: c.variant || '',
      year_from: c.year_from ? String(c.year_from) : '',
      year_to: c.year_to ? String(c.year_to) : '',
      colour: c.colour || '',
      price_from: c.price_from ? formatNumber(c.price_from) : '',
      price_to: c.price_to ? formatNumber(c.price_to) : '',
      mileage_max: c.mileage_max ? formatNumber(c.mileage_max) : '',
      fuel_type: c.fuel_type || '',
      transmission: c.transmission || '',
      body_type: c.doors ? `${c.body_type}|${c.doors}` : (c.body_type || ''),
      exclude_cat: c.exclude_cat !== false,
      postcode: c.postcode || '',
      radius: c.radius ? String(c.radius) : '1500'
    })
    setLoaded(true)
  }, [editId, searches, loaded])

  const [resultCount, setResultCount] = useState(null)
  const [facets, setFacets] = useState(null)
  const countTimer = useRef(null)

  useEffect(() => {
    clearTimeout(countTimer.current)

    // Build criteria object (same logic as handleSubmit)
    const criteria = {}
    if (form.make) criteria.make = form.make
    if (form.model) criteria.model = form.model
    if (form.variant) criteria.variant = form.variant
    if (form.year_from) criteria.year_from = Number(form.year_from)
    if (form.year_to) criteria.year_to = Number(form.year_to)
    if (form.colour) criteria.colour = form.colour
    if (form.price_from) criteria.price_from = Number(parseNumber(form.price_from))
    if (form.price_to) criteria.price_to = Number(parseNumber(form.price_to))
    if (form.mileage_max) criteria.mileage_max = Number(parseNumber(form.mileage_max))
    if (form.fuel_type) criteria.fuel_type = form.fuel_type
    if (form.transmission) criteria.transmission = form.transmission
    if (form.body_type) {
      const [bt, doors] = form.body_type.split('|')
      criteria.body_type = bt
      if (doors) criteria.doors = doors
    }
    criteria.exclude_cat = form.exclude_cat
    if (form.postcode) {
      criteria.postcode = form.postcode
      if (form.radius) criteria.radius = Number(form.radius)
    }

    countTimer.current = setTimeout(() => {
      apiPost('/api/search-count', criteria)
        .then(r => {
          setResultCount(r.count)
          if (r.facets) setFacets(r.facets)
        })
        .catch(() => {})
    }, 500)

    return () => clearTimeout(countTimer.current)
  }, [form.make, form.model, form.variant, form.year_from, form.year_to, form.colour,
      form.price_from, form.price_to, form.mileage_max, form.fuel_type, form.transmission,
      form.body_type, form.exclude_cat, form.postcode, form.radius])

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
      if (form.model) criteria.model = form.model
      if (form.variant) criteria.variant = form.variant
      if (form.year_from) criteria.year_from = Number(form.year_from)
      if (form.year_to) criteria.year_to = Number(form.year_to)
      if (form.colour) criteria.colour = form.colour
      if (form.price_from) criteria.price_from = Number(parseNumber(form.price_from))
      if (form.price_to) criteria.price_to = Number(parseNumber(form.price_to))
      if (form.mileage_max) criteria.mileage_max = Number(parseNumber(form.mileage_max))
      if (form.fuel_type) criteria.fuel_type = form.fuel_type
      if (form.transmission) criteria.transmission = form.transmission
      if (form.body_type) {
        const [bt, doors] = form.body_type.split('|')
        criteria.body_type = bt
        if (doors) criteria.doors = doors
      }
      criteria.exclude_cat = form.exclude_cat
      if (form.postcode) {
        criteria.postcode = form.postcode
        if (form.radius) criteria.radius = Number(form.radius)
      }

      const name = form.name || `${form.make || 'Any'} ${form.model || ''}`.trim()
      if (editId) {
        await updateSearch(editId, { name, criteria })
      } else {
        await createSearch(name, criteria)
      }
      localStorage.removeItem(draftKey)
      navigate('/')
    } catch (err) {
      if (err.message.includes('Subscribe') || err.message.includes('Buy another slot')) {
        setError(null)
        navigate('/buy-slot')
        return
      }
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const models = [...(taxonomy?.makes?.[form.make]?.models || [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
  const selectedModel = models.find(m => m.value === form.model)
  const trims = [...(selectedModel?.trims || [])].sort((a, b) => a.label.localeCompare(b.label))
  const fmtCount = (n) => n > 0 ? ` (${n.toLocaleString('en-GB')})` : ''

  // Merge static options with facet counts — all static options always visible,
  // faceted options show count, non-faceted show (0)
  const facetOptions = (facetKey, staticList) => {
    const entries = facets?.[facetKey]
    if (!entries?.length) return staticList
    const countMap = Object.fromEntries(entries.map(f => [f.value, f]))
    // Start with static list, annotate with counts
    const opts = staticList.map(s => {
      const f = countMap[s.value]
      const rawCount = f ? f.count : 0
      return { value: s.value, label: `${s.label} (${rawCount.toLocaleString('en-GB')})`, _count: rawCount }
    })
    // Add any facet entries not in the static list (edge cases)
    for (const f of entries) {
      if (!staticList.some(s => s.value === f.value)) {
        opts.push({ value: f.value, label: `${f.displayName} (${f.count.toLocaleString('en-GB')})`, _count: f.count })
      }
    }
    // Sort by count descending
    return opts.sort((a, b) => (b._count ?? 0) - (a._count ?? 0))
  }

  const buildBodyDoorOptions = () => {
    const doorMap = makesData.bodyTypeDoors || {}
    const entries = facets?.body_type
    const countMap = entries?.length
      ? Object.fromEntries(entries.map(f => [f.value, f]))
      : {}

    const items = makesData.bodyTypes.map(bt => {
      const f = countMap[bt.value]
      return { ...bt, count: f ? f.count : 0 }
    })
    const seen = new Set(makesData.bodyTypes.map(bt => bt.value))
    if (entries) {
      for (const f of entries) {
        if (!seen.has(f.value)) {
          items.push({ value: f.value, label: f.displayName, count: f.count })
        }
      }
    }

    // Sort by count once any other criterion is set (facets are filtered)
    const hasCriteria = form.make || form.price_from || form.price_to || form.year_from || form.year_to || form.mileage_max || form.fuel_type || form.transmission
    if (hasCriteria) items.sort((a, b) => b.count - a.count)

    const opts = []
    for (const bt of items) {
      const doors = doorMap[bt.value]
      const countStr = bt.count.toLocaleString('en-GB')
      if (!doors || doors.length === 0) {
        opts.push({ value: bt.value, label: `${bt.label} (${countStr})` })
      } else if (doors.length === 1) {
        opts.push({ value: `${bt.value}|${doors[0]}`, label: `${bt.label} ${doors[0]}dr (${countStr})` })
      } else {
        opts.push({ value: bt.value, label: `${bt.label} (${countStr})` })
        for (const d of doors) {
          opts.push({ value: `${bt.value}|${d}`, label: `\u00a0\u00a0${bt.label} ${d}dr` })
        }
      }
    }
    return opts
  }

  const bodyTypeOpts = buildBodyDoorOptions()
  const fuelTypeOpts = facetOptions('fuel_type', makesData.fuelTypes)
  const transmissionOpts = facetOptions('transmission', makesData.transmissions)
  const colourOpts = facetOptions('colour', makesData.colours)

  return (
    <div className="page">
      <div className="search-editor">
        <h2>
          {editId ? 'Edit Search' : 'New Search'}
          {resultCount !== null && ` (${resultCount.toLocaleString('en-GB')})`}
        </h2>
        <form onSubmit={handleSubmit}>
          <div className="input-group" style={{ marginBottom: 16 }}>
            <label>Search Name (optional)</label>
            <input
              type="text"
              placeholder={`Default: ${form.make || 'Make'} ${form.model || ''} ${form.variant || ''}`.trim()}
              value={form.name}
              onChange={set('name')}
            />
          </div>

          <div className="search-editor-grid">
            {/* Row 1: Make, Model, Variant */}
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
              <select value={form.model} onChange={set('model')} disabled={!form.make || taxonomyLoading}>
                <option value="">
                  {!form.make ? 'Select make' : taxonomyLoading ? 'Loading...' : 'Any'}
                </option>
                {models.map(m => (
                  <option key={m.value} value={m.value}>{m.label}{fmtCount(m.count)}</option>
                ))}
              </select>
            </div>

            <div className="input-group">
              <label>Variant</label>
              <select value={form.variant} onChange={set('variant')} disabled={!trims.length}>
                <option value="">
                  {trims.length ? 'Any' : !form.model ? 'Select model' : 'No variants'}
                </option>
                {trims.map(v => (
                  <option key={v.value} value={v.value}>{v.label}{fmtCount(v.count)}</option>
                ))}
              </select>
            </div>

            {/* Row 2: Year From, Year To, Colour */}
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
              <label>Colour</label>
              <select value={form.colour} onChange={set('colour')}>
                <option value="">Any</option>
                {colourOpts.map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>

            {/* Row 3: Min Price, Max Price, Mileage */}
            <div className="input-group">
              <label>Min Price (£)</label>
              <input
                type="text"
                inputMode="numeric"
                placeholder="e.g. 5,000"
                value={form.price_from}
                onChange={set('price_from')}
              />
            </div>

            <div className="input-group">
              <label>Max Price (£)</label>
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

            {/* Row 4: Fuel, Postcode, Distance */}
            <div className="input-group">
              <label>Fuel</label>
              <select value={form.fuel_type} onChange={set('fuel_type')}>
                <option value="">Any</option>
                {fuelTypeOpts.map(f => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </div>

            <div className="input-group">
              <label>Postcode</label>
              <input
                type="text"
                placeholder="Optional"
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

          <div className="search-editor-bottom">
            <div className="input-group">
              <label>CAT Vehicles</label>
              <button
                type="button"
                className={`btn-toggle ${form.exclude_cat ? 'active' : 'warning'}`}
                onClick={() => setForm(f => ({ ...f, exclude_cat: !f.exclude_cat }))}
              >
                {form.exclude_cat ? 'Excluded' : 'Included'}
              </button>
            </div>

            <div className="input-group">
              <label>Gearbox</label>
              <select value={form.transmission} onChange={set('transmission')}>
                <option value="">Any</option>
                {transmissionOpts.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            <div className="input-group">
              <label>Body Type</label>
              <select value={form.body_type} onChange={set('body_type')}>
                <option value="">Any</option>
                {bodyTypeOpts.map(b => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
            </div>
          </div>

          {error && <p className="error-msg">{error}</p>}

          <div className="search-editor-actions">
            <a href="/" className="btn btn-secondary" onClick={e => { e.preventDefault(); localStorage.removeItem(draftKey); navigate('/') }}>Cancel</a>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : editId ? 'Save Changes' : 'Create Search'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
