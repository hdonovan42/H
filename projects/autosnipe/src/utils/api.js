const TOKEN_KEY = 'autosnipe_token'

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY)
  const headers = { ...options.headers }

  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const res = await fetch(path, { ...options, headers })

  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY)
    window.location.hash = '#/'
    throw new Error('Not authenticated')
  }

  return res
}

export async function apiGet(path) {
  const res = await apiFetch(path)
  if (!res.ok) throw new Error((await res.json()).error || res.statusText)
  return res.json()
}

export async function apiPost(path, body) {
  const res = await apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(body)
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

export async function apiDelete(path) {
  const res = await apiFetch(path, { method: 'DELETE' })
  if (!res.ok) throw new Error((await res.json()).error || res.statusText)
  return res.json()
}

export async function apiPatch(path, body) {
  const res = await apiFetch(path, {
    method: 'PATCH',
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error((await res.json()).error || res.statusText)
  return res.json()
}
