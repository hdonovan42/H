import { useState, useEffect, useCallback, useRef } from 'react'
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
  const pollRef = useRef(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  const fetchSearches = useCallback(async () => {
    if (isDev) return null
    try {
      const data = await apiGet('/api/searches')
      setSearches(data)
      return data
    } catch (err) {
      console.error('Failed to fetch searches:', err)
      return null
    } finally {
      setLoading(false)
    }
  }, [isDev])

  // Poll every 2s while any active search has never been checked (background poll still running)
  const startPolling = useCallback(() => {
    stopPolling()
    let attempts = 0
    pollRef.current = setInterval(async () => {
      attempts++
      const data = await fetchSearches()
      if (!data || !data.some(s => s.active && !s.last_checked) || attempts >= 15) {
        stopPolling()
      }
    }, 2000)
  }, [fetchSearches, stopPolling])

  useEffect(() => {
    fetchSearches().then(data => {
      if (data?.some(s => s.active && !s.last_checked)) startPolling()
    })
    return stopPolling
  }, [fetchSearches, startPolling, stopPolling])

  const createSearch = async (name, criteria) => {
    const result = await apiPost('/api/searches', { name, criteria })
    await fetchSearches()
    startPolling()
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
