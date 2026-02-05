import { MODEL_CONFIG } from './AgentSimulator'

/**
 * ApiAdapter — bridges AgentSimulator with the real Claude API backend.
 * Implements the execute(unit, task) contract that AgentSimulator.executeTask() expects.
 */
export class ApiAdapter {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl || import.meta.env.VITE_API_URL || ''
    this.token = token || import.meta.env.VITE_API_TOKEN || ''
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' }
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  async execute(unit, task) {
    const modelConfig = MODEL_CONFIG[unit.rank]
    if (!modelConfig || modelConfig.model === 'user') {
      return { success: false, error: 'Cannot execute for user/chief rank', tokens: 0 }
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/execute`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({
          unit: { id: unit.id, name: unit.name, rank: unit.rank },
          task: { description: task.description, context: task.context || '' },
          model: modelConfig.model,
          tools: task.tools || undefined,
          missionId: task.missionId || undefined,
          previousContext: task.previousContext || undefined
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        return { success: false, error: `API error (${response.status}): ${errorText}`, tokens: 0 }
      }

      const data = await response.json()

      return {
        success: data.success,
        result: data.result || data.error,
        error: data.error || null,
        tokens: data.tokens?.total || 0,
        duration: data.duration || 0,
        model: data.model || null,
        searchCount: data.searchCount || 0
      }
    } catch (error) {
      return {
        success: false,
        error: `Network error: ${error.message}`,
        tokens: 0
      }
    }
  }

  async executeStream(unit, task, onDelta, onToolUse) {
    const modelConfig = MODEL_CONFIG[unit.rank]
    if (!modelConfig || modelConfig.model === 'user') {
      return { success: false, error: 'Cannot execute for user/chief rank', tokens: 0 }
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/execute/stream`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({
          unit: { id: unit.id, name: unit.name, rank: unit.rank },
          task: { description: task.description, context: task.context || '' },
          model: modelConfig.model,
          tools: task.tools || undefined,
          missionId: task.missionId || undefined,
          previousContext: task.previousContext || undefined
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        return { success: false, error: `API error (${response.status}): ${errorText}`, tokens: 0 }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let fullText = ''
      let finalResult = null
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue

          try {
            const event = JSON.parse(data)

            if (event.type === 'text_delta') {
              fullText += event.text
              if (onDelta) onDelta(event.text, fullText)
            } else if (event.type === 'tool_use') {
              if (onToolUse) onToolUse(event.name, event.input)
            } else if (event.type === 'done') {
              finalResult = {
                success: true,
                result: fullText,
                tokens: event.tokens?.total || 0,
                duration: event.duration || 0,
                searchCount: event.searchCount || 0
              }
            } else if (event.type === 'error') {
              return {
                success: false,
                error: event.error,
                tokens: 0
              }
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }

      return finalResult || { success: true, result: fullText, tokens: 0 }
    } catch (error) {
      return {
        success: false,
        error: `Network error: ${error.message}`,
        tokens: 0
      }
    }
  }

  async route(message) {
    try {
      const response = await fetch(`${this.baseUrl}/api/route`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ message })
      })

      if (!response.ok) {
        return null
      }

      return await response.json()
    } catch {
      return null
    }
  }

  async startMission(missionId, objective) {
    try {
      await fetch(`${this.baseUrl}/api/mission/start`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ missionId, objective })
      })
    } catch {
      // Non-critical
    }
  }

  async healthCheck() {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`)
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` }
      }
      const data = await response.json()
      return {
        ok: data.status === 'ok',
        status: data.status,
        models: data.models || [],
        error: data.status !== 'ok' ? `Backend status: ${data.status}` : null
      }
    } catch (error) {
      return { ok: false, error: `Cannot reach API: ${error.message}` }
    }
  }
}
