import { useState, useCallback, useRef } from 'react'

export default function useProposalChat(proposalId) {
  const [messages, setMessages] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const abortRef = useRef(null)

  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || isLoading || !proposalId) return

    const userMsg = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setIsLoading(true)

    const history = messages.map(m => ({ role: m.role, content: m.content }))

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(`/api/v2/proposals/${proposalId}/chat`, {
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

            if (event.type === 'response') {
              setMessages(prev => [...prev, {
                role: 'assistant',
                content: event.text,
                tokens: event.tokens,
                duration: event.duration
              }])
            } else if (event.type === 'error') {
              setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${event.error}`, error: true }])
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', content: `Connection error: ${err.message}`, error: true }])
      }
    } finally {
      setIsLoading(false)
      abortRef.current = null
    }
  }, [messages, isLoading, proposalId])

  const clearChat = useCallback(() => {
    if (abortRef.current) abortRef.current.abort()
    setMessages([])
    setIsLoading(false)
  }, [])

  return { messages, sendMessage, isLoading, clearChat }
}
