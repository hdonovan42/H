import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadActuators() {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, '../../src/data/actuators.json'), 'utf-8'))
  } catch {
    return []
  }
}

export default {
  actuatorId: 'strategic-planning',

  tools: [
    {
      name: 'assess_research_priorities',
      description: 'Rank actuators by composite priority score based on feasibility, dependency readiness, and evidence gaps.',
      input_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional: filter by actuator category' },
          limit: { type: 'number', description: 'Max results to return (default 15)' }
        },
        required: []
      }
    },
    {
      name: 'dependency_analysis',
      description: 'Map critical paths through the actuator dependency graph. Find bottleneck actuators and unblock potential.',
      input_schema: {
        type: 'object',
        properties: {
          actuatorId: { type: 'string', description: 'Optional: analyze dependencies for a specific actuator' }
        },
        required: []
      }
    },
  ],

  execute: async (toolName, input, context) => {
    const { state } = context
    const seed = loadActuators()
    const kb = state.knowledgeBase || {}
    const statuses = { ...kb.actuatorStatuses, ...kb.confirmedActuators }
    const findings = kb.keyFindings || []
    const sessions = state.sessions || []

    // Merge seed with live statuses
    const actuators = seed.map(a => ({
      ...a,
      status: statuses[a.id] || a.status
    }))

    if (toolName === 'assess_research_priorities') {
      const limit = Math.min(input.limit || 15, 40)
      let candidates = actuators.filter(a => a.status !== 'distant' && a.status !== 'blocked')

      if (input.category) {
        candidates = candidates.filter(a => a.category === input.category)
      }

      // Score each candidate
      const scored = candidates.map(a => {
        const feasibilityScore = (a.feasibility || 0) * 30

        // Dependency readiness: what fraction of deps are confirmed?
        const deps = a.dependencies || []
        const depsReady = deps.length === 0 ? 1 :
          deps.filter(d => statuses[d] === 'confirmed').length / deps.length
        const depScore = depsReady * 30

        // Evidence gap: fewer findings mentioning this actuator = higher priority
        const mentions = findings.filter(f =>
          f.toLowerCase().includes(a.id) || f.toLowerCase().includes(a.name.toLowerCase())
        ).length
        const evidenceGap = Math.max(0, 20 - mentions * 5)

        // Status bonus: theoretical gets a nudge over confirmed
        const statusBonus = a.status === 'theoretical' ? 20 : 0

        const total = parseFloat((feasibilityScore + depScore + evidenceGap + statusBonus).toFixed(1))

        return {
          id: a.id,
          name: a.name,
          category: a.category,
          status: a.status,
          feasibility: a.feasibility,
          depsReady: `${deps.filter(d => statuses[d] === 'confirmed').length}/${deps.length}`,
          evidenceMentions: mentions,
          priorityScore: total
        }
      })

      scored.sort((a, b) => b.priorityScore - a.priorityScore)

      return JSON.stringify({
        candidateCount: scored.length,
        topPriorities: scored.slice(0, limit)
      }, null, 2)
    }

    if (toolName === 'dependency_analysis') {
      const actuatorMap = Object.fromEntries(actuators.map(a => [a.id, a]))

      if (input.actuatorId) {
        const target = actuatorMap[input.actuatorId]
        if (!target) return `Error: actuator "${input.actuatorId}" not found`

        // Walk dependency tree
        const chain = []
        const visited = new Set()
        function walk(id, depth) {
          if (visited.has(id)) return
          visited.add(id)
          const a = actuatorMap[id]
          if (!a) return
          chain.push({ id, name: a.name, status: a.status, depth })
          for (const dep of (a.dependencies || [])) {
            walk(dep, depth + 1)
          }
        }
        walk(input.actuatorId, 0)

        const blockers = chain.filter(c => c.status !== 'confirmed' && c.depth > 0)

        return JSON.stringify({
          target: input.actuatorId,
          dependencyChain: chain,
          blockers,
          unblockPath: blockers.sort((a, b) => b.depth - a.depth).map(b => b.id)
        }, null, 2)
      }

      // Global bottleneck analysis: which actuators are depended on most?
      const depCounts = {}
      for (const a of actuators) {
        for (const dep of (a.dependencies || [])) {
          depCounts[dep] = (depCounts[dep] || 0) + 1
        }
      }

      const bottlenecks = Object.entries(depCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, count]) => ({
          id,
          name: actuatorMap[id]?.name || id,
          status: actuatorMap[id]?.status || 'unknown',
          dependedOnBy: count,
          confirmed: (actuatorMap[id]?.status === 'confirmed' || statuses[id] === 'confirmed')
        }))

      return JSON.stringify({
        bottlenecks,
        insight: bottlenecks.filter(b => !b.confirmed).length > 0
          ? `${bottlenecks.filter(b => !b.confirmed).length} bottleneck actuators are not yet confirmed — confirming these would unblock the most downstream actuators.`
          : 'All major bottleneck actuators are confirmed.'
      }, null, 2)
    }

    return `Unknown tool: ${toolName}`
  },

  verify: async (context) => {
    const seed = loadActuators()
    const { state } = context
    const sessions = state.sessions || []

    if (seed.length > 0 && sessions.length >= 3) {
      return {
        operational: true,
        evidence: `${seed.length} actuators loaded, ${sessions.length} sessions available for planning`
      }
    }

    return {
      operational: false,
      evidence: `Need actuator data and 3+ sessions (have ${seed.length} actuators, ${sessions.length} sessions)`
    }
  }
}
