import { useState, useEffect, useCallback } from 'react'
import { apiGet } from '../utils/api'

export default function useMatches() {
  const [matches, setMatches] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchMatches = useCallback(async () => {
    try {
      const data = await apiGet('/api/matches/recent')
      setMatches(data)
    } catch (err) {
      console.error('Failed to fetch matches:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchMatches() }, [fetchMatches])

  return { matches, loading, refresh: fetchMatches }
}
