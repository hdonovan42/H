import { verifyAll, getAllModules, getActiveModules } from './registry.js'

export default {
  actuatorId: 'automated-verification',

  tools: [
    {
      name: 'verify_capabilities',
      description: 'Run verification checks on all capability modules. Returns operational status and evidence for each.',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'validate_statuses',
      description: 'Compare claimed actuator statuses against evidence from sessions. Flags inconsistencies.',
      input_schema: {
        type: 'object',
        properties: {
          actuatorId: { type: 'string', description: 'Optional: check a specific actuator. Omit to check all.' }
        },
        required: []
      }
    }
  ],

  execute: async (toolName, input, context) => {
    const { state } = context

    if (toolName === 'verify_capabilities') {
      const results = await verifyAll()
      const modules = getAllModules()
      const active = getActiveModules()
      const activeIds = new Set(active.flatMap(m => Array.isArray(m.actuatorId) ? m.actuatorId : [m.actuatorId]))

      const report = {
        totalModules: modules.length,
        activeModules: active.length,
        verificationResults: Object.entries(results).map(([id, r]) => ({
          actuatorId: id,
          active: activeIds.has(id),
          operational: r.operational,
          lastVerified: r.lastVerified,
          evidence: r.evidence
        }))
      }

      console.log(`[automated-verification] Verified ${Object.keys(results).length} actuators`)
      return JSON.stringify(report, null, 2)
    }

    if (toolName === 'validate_statuses') {
      const kb = state.knowledgeBase || {}
      const claimed = { ...kb.actuatorStatuses, ...kb.confirmedActuators }
      const findings = kb.keyFindings || []
      const sessions = state.sessions || []
      const issues = []

      const checkIds = input.actuatorId ? [input.actuatorId] : Object.keys(claimed)

      for (const id of checkIds) {
        const status = claimed[id]
        if (!status) {
          issues.push({ actuatorId: id, issue: 'no status recorded' })
          continue
        }

        // Look for supporting evidence in findings
        const evidence = findings.filter(f => f.toLowerCase().includes(id.replace(/-/g, ' ')) || f.toLowerCase().includes(id))
        const sessionMentions = sessions.filter(s =>
          (s.synthesis || '').toLowerCase().includes(id) ||
          (s.directorPlan || '').toLowerCase().includes(id)
        ).length

        if (status === 'confirmed' && evidence.length === 0 && sessionMentions === 0) {
          issues.push({
            actuatorId: id,
            claimedStatus: status,
            issue: 'confirmed but no supporting evidence found in findings or sessions',
            severity: 'high'
          })
        } else if (status === 'confirmed' && evidence.length === 0) {
          issues.push({
            actuatorId: id,
            claimedStatus: status,
            issue: `confirmed with ${sessionMentions} session mentions but no explicit finding`,
            severity: 'low'
          })
        }
      }

      return JSON.stringify({
        checkedCount: checkIds.length,
        issuesFound: issues.length,
        issues,
        totalFindings: findings.length,
        totalSessions: sessions.length
      }, null, 2)
    }

    return `Unknown tool: ${toolName}`
  },

  verify: async (context) => {
    const { state } = context
    const sessions = state.sessions || []
    const findings = state.knowledgeBase?.keyFindings || []

    if (sessions.length >= 5 && findings.length >= 3) {
      return {
        operational: true,
        evidence: `Sufficient data for validation: ${sessions.length} sessions, ${findings.length} findings`
      }
    }

    return {
      operational: false,
      evidence: `Need more data: ${sessions.length}/5 sessions, ${findings.length}/3 findings`
    }
  }
}
