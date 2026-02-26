import { useState, useEffect, useCallback } from 'react'
import { apiGet } from '../utils/api'

const TOKEN_KEY = 'autosnipe_token'

export default function useAuth() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  const fetchUser = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await apiGet('/api/auth/me')
      setUser(data)
    } catch (err) {
      if (err.message === 'Not authenticated') {
        localStorage.removeItem(TOKEN_KEY)
        setToken(null)
      }
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { fetchUser() }, [fetchUser])

  const login = (newToken) => {
    localStorage.setItem(TOKEN_KEY, newToken)
    setToken(newToken)
  }

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    setUser(null)
    window.location.hash = '#/'
  }

  return { user, loading, token, login, logout, refresh: fetchUser }
}
