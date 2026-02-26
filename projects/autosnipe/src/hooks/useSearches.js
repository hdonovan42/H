import { useState, useEffect, useCallback } from 'react'
import { apiGet, apiPost, apiDelete, apiPatch } from '../utils/api'

export default function useSearches() {
  const [searches, setSearches] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchSearches = useCallback(async () => {
    try {
      const data = await apiGet('/api/searches')
      setSearches(data)
    } catch (err) {
      console.error('Failed to fetch searches:', err)
    } finally {
      setLoading(false)
    }
  }, [])

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
