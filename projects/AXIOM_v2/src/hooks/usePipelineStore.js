import { useSyncExternalStore } from 'react'

// Module-scoped state — survives component unmount/remount
let _events = []
let _running = false
let _pipelineState = null
let _listeners = new Set()
let _abortController = null
let _pollInterval = null

function _notify() {
  const snapshot = _makeSnapshot()
  _snapshotRef = snapshot
  _listeners.forEach(fn => fn())
}

function _makeSnapshot() {
  return { events: _events, running: _running, pipelineState: _pipelineState }
}

let _snapshotRef = _makeSnapshot()

function subscribe(listener) {
  _listeners.add(listener)
  return () => _listeners.delete(listener)
}

function getSnapshot() {
  return _snapshotRef
}

function addEvent(evt) {
  _events = [..._events, evt]
  _notify()
}

async function _readStream(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ') || line.slice(6) === '[DONE]') continue
        try {
          addEvent(JSON.parse(line.slice(6)))
        } catch {}
      }
    }
  } finally {
    _running = false
    _abortController = null
    _notify()
  }
}

async function runPipeline(target) {
  if (!target.capabilityId || !target.valueId) return
  _running = true
  _events = []
  _abortController = new AbortController()
  _notify()

  try {
    const res = await fetch('/api/v2/pipeline/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(target),
      signal: _abortController.signal
    })
    await _readStream(res)
  } catch (err) {
    if (err.name !== 'AbortError') {
      addEvent({ type: 'error', error: err.message })
    }
    _running = false
    _abortController = null
    _notify()
  }
}

async function runAuto() {
  _running = true
  _events = []
  _abortController = new AbortController()
  _notify()

  try {
    const res = await fetch('/api/v2/pipeline/run-auto', {
      method: 'POST',
      credentials: 'include',
      signal: _abortController.signal
    })
    await _readStream(res)
  } catch (err) {
    if (err.name !== 'AbortError') {
      addEvent({ type: 'error', error: err.message })
    }
    _running = false
    _abortController = null
    _notify()
  }
}

async function killPipeline() {
  try {
    const res = await fetch('/api/v2/pipeline/abort', { method: 'POST', credentials: 'include' })
    const data = await res.json()
    addEvent({ type: 'abort', ...data })
    _running = false
    _notify()
  } catch (err) {
    addEvent({ type: 'error', error: `Abort failed: ${err.message}` })
  }
}

function clearEvents() {
  _events = []
  _notify()
}

// Poll /pipeline/active every 3s — starts on module load
function _startPolling() {
  if (_pollInterval) return
  const poll = () => {
    fetch('/api/v2/pipeline/active', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        _pipelineState = data
        _notify()
      })
      .catch(() => {})
  }
  poll()
  _pollInterval = setInterval(poll, 3000)
}

_startPolling()

export default function usePipelineStore() {
  return useSyncExternalStore(subscribe, getSnapshot)
}

export { subscribe, getSnapshot, runPipeline, runAuto, killPipeline, clearEvents }
