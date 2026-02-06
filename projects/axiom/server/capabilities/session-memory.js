export default {
  actuatorId: 'session-memory',

  tools: [
    {
      name: 'query_findings',
      description: 'Search AXIOM knowledge base for past findings by keyword',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term or phrase to match against key findings and session syntheses' }
        },
        required: ['query']
      }
    },
    {
      name: 'get_session_history',
      description: 'Return summary of the last N AXIOM research sessions',
      input_schema: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Number of recent sessions to return (default 5, max 20)' }
        },
        required: []
      }
    }
  ],

  execute: async (toolName, input, context) => {
    const { state } = context

    if (toolName === 'query_findings') {
      const query = (input.query || '').toLowerCase()
      if (!query) return 'Error: query parameter is required'

      const results = []

      // Search key findings
      const findings = state.knowledgeBase?.keyFindings || []
      for (const finding of findings) {
        if (finding.toLowerCase().includes(query)) {
          results.push({ type: 'finding', text: finding })
        }
      }

      // Search session syntheses
      const sessions = state.sessions || []
      for (const session of sessions) {
        if (session.synthesis && session.synthesis.toLowerCase().includes(query)) {
          results.push({
            type: 'session_synthesis',
            sessionId: session.id,
            timestamp: session.timestamp,
            excerpt: extractExcerpt(session.synthesis, query)
          })
        }
      }

      if (results.length === 0) {
        return `No findings matched "${input.query}". The knowledge base has ${findings.length} findings across ${sessions.length} sessions.`
      }

      return JSON.stringify({ query: input.query, matchCount: results.length, results: results.slice(0, 15) }, null, 2)
    }

    if (toolName === 'get_session_history') {
      const count = Math.min(Math.max(input.count || 5, 1), 20)
      const sessions = state.sessions || []
      const recent = sessions.slice(-count)

      if (recent.length === 0) {
        return 'No sessions have been recorded yet.'
      }

      const summaries = recent.map(s => ({
        id: s.id,
        timestamp: s.timestamp,
        type: s.type,
        searchCount: s.searchCount || 0,
        findingCount: (s.proposedUpdates || []).length,
        synthesis: s.synthesis ? s.synthesis.slice(0, 300) : 'no synthesis'
      }))

      return JSON.stringify({ sessionCount: sessions.length, showing: recent.length, sessions: summaries }, null, 2)
    }

    return `Unknown tool: ${toolName}`
  },

  verify: async (context) => {
    const { state } = context
    const sessions = state.sessions || []
    const findings = state.knowledgeBase?.keyFindings || []

    if (sessions.length >= 3 && findings.length > 0) {
      return {
        operational: true,
        evidence: `${sessions.length} sessions with ${findings.length} searchable findings`
      }
    }

    return {
      operational: false,
      evidence: `Need 3+ sessions with findings (have ${sessions.length} sessions, ${findings.length} findings)`
    }
  }
}

function extractExcerpt(text, query) {
  const lower = text.toLowerCase()
  const idx = lower.indexOf(query)
  if (idx === -1) return text.slice(0, 200)
  const start = Math.max(0, idx - 80)
  const end = Math.min(text.length, idx + query.length + 80)
  return (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '')
}
