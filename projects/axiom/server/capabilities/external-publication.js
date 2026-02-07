export default {
  actuatorId: 'external-publication',

  tools: [
    {
      name: 'generate_report',
      description: 'Generate a formatted research report from recent AXIOM sessions. Returns markdown suitable for publication.',
      input_schema: {
        type: 'object',
        properties: {
          sessionCount: { type: 'number', description: 'Number of recent sessions to include (default 5)' },
          format: {
            type: 'string',
            enum: ['summary', 'detailed', 'changelog'],
            description: 'Report format. summary: high-level overview. detailed: full findings. changelog: what changed.'
          }
        },
        required: []
      }
    },
    {
      name: 'export_findings',
      description: 'Export all key findings as structured data, grouped by topic.',
      input_schema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Optional topic filter — only export findings mentioning this term' }
        },
        required: []
      }
    }
  ],

  execute: async (toolName, input, context) => {
    const { state } = context
    const kb = state.knowledgeBase || {}

    if (toolName === 'generate_report') {
      const sessions = state.sessions || []
      const count = Math.min(Math.max(input.sessionCount || 5, 1), 20)
      const format = input.format || 'summary'
      const recent = sessions.slice(-count)

      if (recent.length === 0) {
        return 'No sessions available to report on.'
      }

      const confirmed = Object.entries({ ...kb.confirmedActuators, ...kb.actuatorStatuses })
        .filter(([, v]) => v === 'confirmed')
        .map(([id]) => id)

      const lines = []
      lines.push(`# AXIOM Research Report`)
      lines.push(`Generated: ${new Date().toISOString()}`)
      lines.push(`Sessions covered: ${recent[0].id || 'first'} to ${recent[recent.length - 1].id || 'latest'}`)
      lines.push('')

      lines.push(`## System State`)
      lines.push(`- Total sessions: ${state.sessionCount || 0}`)
      lines.push(`- Key findings: ${(kb.keyFindings || []).length}`)
      lines.push(`- Confirmed actuators: ${confirmed.join(', ') || 'none'}`)
      lines.push('')

      if (format === 'summary' || format === 'detailed') {
        lines.push(`## Session Summaries`)
        for (const s of recent) {
          const tokens = (s.tokens?.input || 0) + (s.tokens?.output || 0)
          lines.push(`### ${s.id} (${s.type}) — ${s.timestamp}`)
          if (format === 'detailed' && s.synthesis) {
            lines.push(s.synthesis.slice(0, 1500))
          } else if (s.synthesis) {
            lines.push(s.synthesis.slice(0, 400))
          }
          lines.push(`*${tokens} tokens, ${s.searchCount || 0} searches, ${(s.proposedUpdates || []).length} findings*`)
          lines.push('')
        }
      }

      if (format === 'changelog') {
        lines.push(`## Changes`)
        for (const s of recent) {
          const updates = s.proposedUpdates || []
          if (updates.length === 0) continue
          lines.push(`### ${s.id} (${s.timestamp})`)
          for (const u of updates) {
            if (typeof u === 'string') {
              lines.push(`- ${u.slice(0, 200)}`)
            } else if (u.type && u.actuatorId) {
              lines.push(`- ${u.type}: ${u.actuatorId} → ${u.value || u.status || JSON.stringify(u).slice(0, 100)}`)
            } else {
              lines.push(`- ${JSON.stringify(u).slice(0, 200)}`)
            }
          }
          lines.push('')
        }
      }

      if ((kb.keyFindings || []).length > 0) {
        lines.push(`## Key Findings (last 10)`)
        for (const f of (kb.keyFindings || []).slice(-10)) {
          lines.push(`- ${typeof f === 'string' ? f.slice(0, 300) : JSON.stringify(f).slice(0, 300)}`)
        }
      }

      return lines.join('\n')
    }

    if (toolName === 'export_findings') {
      const findings = kb.keyFindings || []

      if (findings.length === 0) {
        return 'No findings to export.'
      }

      let filtered = findings
      if (input.topic) {
        const topic = input.topic.toLowerCase()
        filtered = findings.filter(f =>
          (typeof f === 'string' ? f : JSON.stringify(f)).toLowerCase().includes(topic)
        )
      }

      return JSON.stringify({
        totalFindings: findings.length,
        exported: filtered.length,
        topic: input.topic || 'all',
        findings: filtered.map((f, i) => ({
          index: i,
          text: typeof f === 'string' ? f : JSON.stringify(f)
        }))
      }, null, 2)
    }

    return `Unknown tool: ${toolName}`
  },

  verify: async (context) => {
    const { state } = context
    const findings = state.knowledgeBase?.keyFindings || []
    const sessions = state.sessions || []

    if (findings.length > 0 && sessions.length >= 3) {
      return {
        operational: true,
        evidence: `${findings.length} findings and ${sessions.length} sessions available for reporting`
      }
    }

    return {
      operational: false,
      evidence: `Need findings and 3+ sessions (have ${findings.length} findings, ${sessions.length} sessions)`
    }
  }
}
