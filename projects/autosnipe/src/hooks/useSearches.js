import { useState, useEffect, useCallback } from 'react'
import { apiGet, apiPost, apiDelete, apiPatch } from '../utils/api'

const DEV_SEARCHES = [
  {
    id: 1, user_id: 0, name: 'Daily BMW', active: true, total_listings: 14,
    last_checked: new Date(Date.now() - 2 * 3600000).toISOString().slice(0, 19),
    criteria: JSON.stringify({ make: 'BMW', model: '3 Series', year_from: 2019, year_to: 2023, price_from: 12000, price_to: 25000, mileage_max: 60000, fuel_type: 'Diesel', transmission: 'Automatic', postcode: 'SW1A 1AA', radius: 75 }),
  },
  {
    id: 2, user_id: 0, name: null, active: true, total_listings: 3,
    last_checked: new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 19),
    criteria: JSON.stringify({ make: 'Volkswagen', model: 'Golf', variant: 'R', year_from: 2020, price_to: 30000, fuel_type: 'Petrol', transmission: 'Automatic', postcode: 'M1 1AE', radius: 50 }),
  },
  {
    id: 3, user_id: 0, name: 'Weekend runabout', active: false, total_listings: 0,
    last_checked: null,
    criteria: JSON.stringify({ make: 'Mazda', model: 'MX-5', year_from: 2016, price_to: 18000, postcode: 'SW1A 1AA', radius: 100 }),
  },
]

export default function useSearches() {
  const isDev = import.meta.env.DEV && localStorage.getItem('autosnipe_token') === 'dev-preview-token'
  const [searches, setSearches] = useState(isDev ? DEV_SEARCHES : [])
  const [loading, setLoading] = useState(!isDev)

  const fetchSearches = useCallback(async () => {
    if (isDev) return
    try {
      const data = await apiGet('/api/searches')
      setSearches(data)
    } catch (err) {
      console.error('Failed to fetch searches:', err)
    } finally {
      setLoading(false)
    }
  }, [isDev])

  useEffect(() => { fetchSearches() }, [fetchSearches])

  const createSearch = async (name, criteria) => {
    const result = await apiPost('/api/searches', { name, criteria })
    await fetchSearches()
    return result
  }

  const deleteSearch = async (id) => {
    await apiDelete(`/api/searches/${id}`)
    await fetchSearches()
  }

  const toggleSearch = async (id, active) => {
    await apiPatch(`/api/searches/${id}`, { active })
    await fetchSearches()
  }

  const updateSearch = async (id, { name, criteria }) => {
    await apiPatch(`/api/searches/${id}`, { name, criteria })
    await fetchSearches()
  }

  return { searches, loading, createSearch, deleteSearch, toggleSearch, updateSearch, refresh: fetchSearches }
}
