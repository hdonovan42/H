import { useState, useEffect, useCallback } from 'react'

export default function useProposals(pollInterval = 5000) {
  const [proposals, setProposals] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchProposals = useCallback(async () => {
    try {
      const res = await fetch('/api/v2/proposals', { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      setProposals(data)
    } catch {} finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchProposals()
    const interval = setInterval(fetchProposals, pollInterval)
    return () => clearInterval(interval)
  }, [fetchProposals, pollInterval])

  const approve = useCallback(async (proposalId) => {
    const res = await fetch(`/api/v2/proposals/${proposalId}/approve`, {
      method: 'POST',
      credentials: 'include'
    })
    const data = await res.json()
    if (data.success) fetchProposals()
    return data
  }, [fetchProposals])

  const reject = useCallback(async (proposalId, reason) => {
    const res = await fetch(`/api/v2/proposals/${proposalId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ reason })
    })
    const data = await res.json()
    if (data.success) fetchProposals()
    return data
  }, [fetchProposals])

  const pending = proposals.filter(p => p.status === 'pending_approval')

  return { proposals, pending, loading, approve, reject, refresh: fetchProposals }
}
