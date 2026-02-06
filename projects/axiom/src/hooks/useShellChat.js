import { useState, useCallback, useRef, useEffect } from 'react'

export default function useShellChat() {
  const [messages, setMessages] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [activeTools, setActiveTools] = useState([])
  const [availableTools, setAvailableTools] = useState([])
  const abortRef = useRef(null)

  useEffect(() => {
    fetch('/api/shell/tools', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setAvailableTools(data.tools || []))
      .catch(() => {})
  }, [])

  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || isLoading) return

    const userMsg = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setIsLoading(true)
    setActiveTools([])

    // Build history from existing messages (excluding tool events)
    const history = messages.map(m => ({ role: m.role, content: m.content }))

    const toolEvents = []
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/shell/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message: text, history }),
        signal: controller.signal
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.error}`, error: true }])
        setIsLoading(false)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6)
          if (payload === '[DONE]') continue

          try {
            const event = JSON.parse(payload)

            if (event.type === 'tool_start') {
              toolEvents.push({ type: 'tool_start', name: event.name, input: event.input })
              setActiveTools(prev => [...prev, event.name])
            } else if (event.type === 'tool_result') {
              toolEvents.push({ type: 'tool_result', name: event.name, resultPreview: event.resultPreview })
              setActiveTools(prev => prev.filter(t => t !== event.name))
            } else if (event.type === 'response') {
              setMessages(prev => [...prev, {
                role: 'assistant',
                content: event.text,
                toolEvents: toolEvents.length > 0 ? [...toolEvents] : undefined,
                tokens: event.tokens,
                duration: event.duration,
                searchCount: event.searchCount
              }])
            } else if (event.type === 'error') {
              setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${event.error}`, error: true }])
            }
          } catch { /* ignore parse errors for partial lines */ }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', content: `Connection error: ${err.message}`, error: true }])
      }
    } finally {
      setIsLoading(false)
      setActiveTools([])
      abortRef.current = null
    }
  }, [messages, isLoading])

  const clearHistory = useCallback(() => {
    if (abortRef.current) abortRef.current.abort()
    setMessages([])
    setIsLoading(false)
    setActiveTools([])
  }, [])

  return { messages, sendMessage, isLoading, activeTools, availableTools, clearHistory }
}
