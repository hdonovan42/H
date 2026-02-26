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

async function safeJson(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(res.ok ? 'Invalid server response' : `Server error (${res.status})`)
  }
}

export async function apiGet(path) {
  const res = await apiFetch(path)
  const data = await safeJson(res)
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

export async function apiPost(path, body) {
  const res = await apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(body)
  })
  const data = await safeJson(res)
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

export async function apiDelete(path) {
  const res = await apiFetch(path, { method: 'DELETE' })
  const data = await safeJson(res)
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

export async function apiPatch(path, body) {
  const res = await apiFetch(path, {
    method: 'PATCH',
    body: JSON.stringify(body)
  })
  const data = await safeJson(res)
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}
