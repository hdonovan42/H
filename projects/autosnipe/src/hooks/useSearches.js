import { useState, useEffect, useCallback } from 'react'
import { apiGet, apiPost, apiDelete } from '../utils/api'

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

  return { searches, loading, createSearch, deleteSearch, refresh: fetchSearches }
}
