import { useState, useEffect, useCallback, useRef } from 'react'

const POLL_INTERVAL = 10_000

export default function useCliState({ autoFetchFull = false } = {}) {
  const [summary, setSummary] = useState(null)
  const [fullState, setFullState] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const lastSummaryRef = useRef(null)

  // Poll summary every 10s
  useEffect(() => {
    let active = true

    async function fetchSummary() {
      try {
        const res = await fetch('/api/state/summary')
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.json()
        if (active) {
          setSummary(data)
          setError(null)
          lastSummaryRef.current = data
        }
      } catch (err) {
        // Silently fail — server might not be running
        if (active && !lastSummaryRef.current) {
          setError(err.message)
        }
      }
    }

    fetchSummary()
    const id = setInterval(fetchSummary, POLL_INTERVAL)
    return () => { active = false; clearInterval(id) }
  }, [])

  // Auto-poll full state when requested (e.g. Research tab is open)
  useEffect(() => {
    if (!autoFetchFull) return
    let active = true

    async function poll() {
      try {
        const res = await fetch('/api/state')
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.json()
        if (active) setFullState(data)
      } catch { /* silent */ }
    }

    poll()
    const id = setInterval(poll, POLL_INTERVAL)
    return () => { active = false; clearInterval(id) }
  }, [autoFetchFull])

  // Fetch full state on demand
  const fetchFullState = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/state')
      if (!res.ok) throw new Error(`${res.status}`)
      const data = await res.json()
      setFullState(data)
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  return { summary, fullState, fetchFullState, loading, error }
}
