import { useState, useEffect, useCallback } from 'react'

export default function useSystemState(pollInterval = 5000) {
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch('/api/v2/state/summary', { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setSummary(data)
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSummary()
    const interval = setInterval(fetchSummary, pollInterval)
    return () => clearInterval(interval)
  }, [fetchSummary, pollInterval])

  return { summary, loading, error, refresh: fetchSummary }
}
