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

// Shared cost rates — single source of truth
const RATES = {
  input: 3.0 / 1_000_000,   // ~$3/MTok input (estimate)
  output: 15.0 / 1_000_000  // ~$15/MTok output (estimate)
}

function sessionCost(s) {
  const inp = s.tokens?.input || 0
  const out = s.tokens?.output || 0
  return inp * RATES.input + out * RATES.output
}

function sessionTokens(s) {
  return (s.tokens?.input || 0) + (s.tokens?.output || 0)
}

function sessionFindings(s) {
  return (s.proposedUpdates || []).length
}

export default {
  actuatorId: [
    'predictive-modeling', 'productivity-advantage', 'resource-acquisition',
    'surveillance', 'recursive-self-improvement', 'intelligence-amplification',
    'tech-perfection'
  ],

  tools: [
    {
      name: 'session_analytics',
      description: 'Flexible session metrics — findings, tokens, cost, efficiency. Group by type, trigger, week, or quartile.',
      input_schema: {
        type: 'object',
        properties: {
          metric: {
            type: 'string',
            enum: ['findings', 'tokens', 'cost', 'efficiency'],
            description: 'Primary metric to analyse (default: efficiency)'
          },
          groupBy: {
            type: 'string',
            enum: ['type', 'trigger', 'week', 'quartile'],
            description: 'How to group sessions (default: type)'
          },
          count: {
            type: 'number',
            description: 'Limit to last N sessions (default: all)'
          }
        },
        required: []
      }
    },
    {
      name: 'research_trends',
      description: 'Time-series analysis: daily bucketing, moving average, trajectory direction, forecast.',
      input_schema: {
        type: 'object',
        properties: {
          metric: {
            type: 'string',
            enum: ['findings', 'tokens', 'sessions', 'cost'],
            description: 'Which metric to track over time (default: findings)'
          }
        },
        required: []
      }
    },
    {
      name: 'scan_research_landscape',
      description: 'Category coverage heatmap across the actuator taxonomy — find blind spots and under-researched areas.',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'evaluate_evidence',
      description: 'Grade evidence strength for an actuator status claim. Returns 0-100 confidence score with rubric.',
      input_schema: {
        type: 'object',
        properties: {
          actuatorId: { type: 'string', description: 'The actuator ID to evaluate' }
        },
        required: ['actuatorId']
      }
    }
  ],

  execute: async (toolName, input, context) => {
    const { state } = context
    const sessions = state.sessions || []
    const kb = state.knowledgeBase || {}
    const statuses = { ...kb.actuatorStatuses, ...kb.confirmedActuators }
    const findings = kb.keyFindings || []

    // --- session_analytics ---
    if (toolName === 'session_analytics') {
      if (sessions.length === 0) return 'No sessions recorded.'

      const count = input.count ? Math.min(input.count, sessions.length) : sessions.length
      const pool = sessions.slice(-count)
      const groupBy = input.groupBy || 'type'
      const metric = input.metric || 'efficiency'

      // Group sessions
      const groups = {}
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i]
        let key
        if (groupBy === 'type') {
          key = s.type || 'unknown'
        } else if (groupBy === 'trigger') {
          key = s.trigger || 'manual'
        } else if (groupBy === 'week') {
          const d = new Date(s.timestamp)
          const weekStart = new Date(d)
          weekStart.setDate(d.getDate() - d.getDay())
          key = weekStart.toISOString().slice(0, 10)
        } else if (groupBy === 'quartile') {
          key = `Q${Math.floor(i / Math.max(1, pool.length / 4)) + 1}`
          if (key === 'Q5') key = 'Q4'
        } else {
          key = s.type || 'unknown'
        }

        if (!groups[key]) groups[key] = { sessions: 0, findings: 0, tokens: 0, cost: 0, searches: 0, ids: [] }
        const g = groups[key]
        g.sessions++
        g.findings += sessionFindings(s)
        g.tokens += sessionTokens(s)
        g.cost += sessionCost(s)
        g.searches += s.searchCount || 0
        g.ids.push(s.id)
      }

      // Build comparison
      const comparison = Object.entries(groups).map(([key, g]) => {
        const entry = {
          group: key,
          sessionCount: g.sessions,
          totalFindings: g.findings,
          totalTokens: g.tokens,
          totalCost: `$${g.cost.toFixed(3)}`,
          avgFindingsPerSession: parseFloat((g.findings / g.sessions).toFixed(2)),
          avgTokensPerSession: Math.round(g.tokens / g.sessions),
          avgCostPerSession: `$${(g.cost / g.sessions).toFixed(3)}`,
          efficiency: g.cost > 0 ? parseFloat((g.findings / g.cost).toFixed(1)) : 0
        }
        return entry
      })

      // Sort by requested metric
      if (metric === 'efficiency') comparison.sort((a, b) => b.efficiency - a.efficiency)
      else if (metric === 'findings') comparison.sort((a, b) => b.totalFindings - a.totalFindings)
      else if (metric === 'cost') comparison.sort((a, b) => parseFloat(b.totalCost.slice(1)) - parseFloat(a.totalCost.slice(1)))
      else comparison.sort((a, b) => b.totalTokens - a.totalTokens)

      // Totals
      const totalCost = pool.reduce((sum, s) => sum + sessionCost(s), 0)
      const totalFindings = pool.reduce((sum, s) => sum + sessionFindings(s), 0)
      const totalTokens = pool.reduce((sum, s) => sum + sessionTokens(s), 0)

      return JSON.stringify({
        sessionsAnalysed: pool.length,
        groupedBy: groupBy,
        sortedBy: metric,
        groups: comparison,
        totals: {
          sessions: pool.length,
          findings: totalFindings,
          tokens: totalTokens,
          cost: `$${totalCost.toFixed(2)}`,
          avgFindingsPerSession: parseFloat((totalFindings / pool.length).toFixed(2)),
          costPerFinding: totalFindings > 0 ? `$${(totalCost / totalFindings).toFixed(3)}` : 'n/a'
        },
        note: 'Costs are estimates (~$3/MTok input, ~$15/MTok output)'
      }, null, 2)
    }

    // --- research_trends ---
    if (toolName === 'research_trends') {
      if (sessions.length < 3) return 'Need at least 3 sessions for trend analysis.'

      const metric = input.metric || 'findings'

      // Bucket by day
      const daily = {}
      for (const s of sessions) {
        const day = (s.timestamp || '').slice(0, 10)
        if (!day) continue
        if (!daily[day]) daily[day] = { sessions: 0, tokens: 0, findings: 0, cost: 0 }
        daily[day].sessions++
        daily[day].tokens += sessionTokens(s)
        daily[day].findings += sessionFindings(s)
        daily[day].cost += sessionCost(s)
      }

      const days = Object.keys(daily).sort()
      const values = days.map(d => metric === 'cost' ? parseFloat(daily[d][metric].toFixed(4)) : daily[d][metric])

      // 3-day moving average
      const ma = values.map((v, i) => {
        if (i < 2) return v
        return parseFloat(((values[i - 2] + values[i - 1] + v) / 3).toFixed(2))
      })

      // Trend direction (first third vs last third)
      const recentAvg = values.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, values.length)
      const earlierAvg = values.slice(0, 3).reduce((a, b) => a + b, 0) / Math.min(3, values.length)
      const trend = recentAvg > earlierAvg * 1.1 ? 'increasing' :
                    recentAvg < earlierAvg * 0.9 ? 'decreasing' : 'stable'

      // Velocity and forecast
      const timestamps = sessions.map(s => new Date(s.timestamp).getTime()).filter(t => !isNaN(t))
      const spanDays = Math.max(1, (Math.max(...timestamps) - Math.min(...timestamps)) / 86400000)
      const sessionsPerDay = sessions.length / spanDays
      const totalFindings = sessions.reduce((sum, s) => sum + sessionFindings(s), 0)
      const findingsPerSession = totalFindings / sessions.length

      return JSON.stringify({
        metric,
        daysTracked: days.length,
        dailyData: days.map((d, i) => ({ date: d, value: values[i], movingAvg: ma[i] })),
        trend,
        recentAvg: parseFloat(recentAvg.toFixed(2)),
        earlierAvg: parseFloat(earlierAvg.toFixed(2)),
        velocity: {
          sessionsPerDay: parseFloat(sessionsPerDay.toFixed(2)),
          findingsPerSession: parseFloat(findingsPerSession.toFixed(2)),
          findingsPerDay: parseFloat((sessionsPerDay * findingsPerSession).toFixed(2))
        },
        forecast: {
          next7Days: {
            estimatedSessions: Math.round(sessionsPerDay * 7),
            estimatedFindings: Math.round(sessionsPerDay * 7 * findingsPerSession)
          }
        }
      }, null, 2)
    }

    // --- scan_research_landscape ---
    if (toolName === 'scan_research_landscape') {
      const seed = loadActuators()

      const categories = {}
      for (const a of seed) {
        const cat = a.category
        if (!categories[cat]) {
          categories[cat] = { total: 0, confirmed: 0, theoretical: 0, blocked: 0, distant: 0, actuators: [] }
        }
        const status = statuses[a.id] || a.status
        categories[cat].total++
        if (status === 'confirmed') categories[cat].confirmed++
        else if (status === 'theoretical') categories[cat].theoretical++
        else if (status === 'blocked') categories[cat].blocked++
        else if (status === 'distant') categories[cat].distant++
        categories[cat].actuators.push({ id: a.id, status })
      }

      // Find mentions per category in findings
      for (const cat of Object.keys(categories)) {
        const catActuators = categories[cat].actuators.map(a => a.id)
        const mentions = findings.filter(f => {
          const lower = f.toLowerCase()
          return catActuators.some(id => lower.includes(id))
        }).length
        categories[cat].findingMentions = mentions
        categories[cat].coverageRatio = parseFloat((mentions / Math.max(1, categories[cat].total)).toFixed(2))
      }

      // Identify blind spots
      const blindSpots = Object.entries(categories)
        .filter(([, data]) => data.coverageRatio < 1 && data.total > 0)
        .sort((a, b) => a[1].coverageRatio - b[1].coverageRatio)
        .map(([cat, data]) => ({
          category: cat,
          coverageRatio: data.coverageRatio,
          underResearched: data.actuators.filter(a => {
            return !findings.some(f => f.toLowerCase().includes(a.id))
          }).map(a => a.id)
        }))

      return JSON.stringify({
        totalActuators: seed.length,
        totalFindings: findings.length,
        categoryBreakdown: Object.entries(categories).map(([cat, data]) => ({
          category: cat,
          total: data.total,
          confirmed: data.confirmed,
          theoretical: data.theoretical,
          blocked: data.blocked,
          distant: data.distant,
          findingMentions: data.findingMentions,
          coverageRatio: data.coverageRatio
        })),
        blindSpots,
        recommendation: blindSpots.length > 0
          ? `${blindSpots[0].category} has the lowest research coverage — consider targeting: ${blindSpots[0].underResearched.slice(0, 3).join(', ')}`
          : 'All categories have reasonable coverage.'
      }, null, 2)
    }

    // --- evaluate_evidence ---
    if (toolName === 'evaluate_evidence') {
      const seed = loadActuators()
      const actuatorMap = Object.fromEntries(seed.map(a => [a.id, a]))
      const a = actuatorMap[input.actuatorId]
      if (!a) return `Error: actuator "${input.actuatorId}" not found in seed data`

      const currentStatus = statuses[input.actuatorId] || a.status

      // Gather evidence
      const mentionedFindings = findings.filter(f =>
        f.toLowerCase().includes(input.actuatorId) ||
        f.toLowerCase().includes(a.name.toLowerCase())
      )

      const mentionedSessions = sessions.filter(s =>
        ((s.synthesis || '') + (s.directorPlan || '')).toLowerCase().includes(input.actuatorId) ||
        ((s.synthesis || '') + (s.directorPlan || '')).toLowerCase().includes(a.name.toLowerCase())
      )

      // Score components
      let confidence = 0
      const reasoning = []

      // Finding count (up to 30 points)
      const findingPoints = Math.min(30, mentionedFindings.length * 10)
      confidence += findingPoints
      reasoning.push(`${mentionedFindings.length} direct findings (+${findingPoints})`)

      // Session coverage (up to 25 points)
      const sessionPoints = Math.min(25, mentionedSessions.length * 5)
      confidence += sessionPoints
      reasoning.push(`${mentionedSessions.length} sessions mention this actuator (+${sessionPoints})`)

      // Has test protocol (10 points)
      if (a.testProtocol) {
        confidence += 10
        reasoning.push('has testProtocol defined (+10)')
      }

      // Has success criteria (10 points)
      if (a.successCriteria) {
        confidence += 10
        reasoning.push('has successCriteria defined (+10)')
      }

      // Feasibility alignment (up to 15 points)
      if (currentStatus === 'confirmed' && a.feasibility >= 0.6) {
        confidence += 15
        reasoning.push(`feasibility ${a.feasibility} aligns with confirmed status (+15)`)
      } else if (currentStatus === 'confirmed' && a.feasibility < 0.3) {
        confidence -= 10
        reasoning.push(`WARNING: feasibility ${a.feasibility} is low for confirmed status (-10)`)
      } else {
        confidence += 5
        reasoning.push(`feasibility ${a.feasibility} noted (+5)`)
      }

      // Dependencies met (up to 10 points)
      const deps = a.dependencies || []
      const depsMet = deps.filter(d => statuses[d] === 'confirmed').length
      if (deps.length === 0 || depsMet === deps.length) {
        confidence += 10
        reasoning.push(`all dependencies met (${depsMet}/${deps.length}) (+10)`)
      } else {
        const partial = Math.round(10 * depsMet / deps.length)
        confidence += partial
        reasoning.push(`${depsMet}/${deps.length} dependencies met (+${partial})`)
      }

      confidence = Math.max(0, Math.min(100, confidence))

      return JSON.stringify({
        actuatorId: input.actuatorId,
        name: a.name,
        claimedStatus: currentStatus,
        confidenceScore: confidence,
        grade: confidence >= 80 ? 'A — strong evidence' :
               confidence >= 60 ? 'B — moderate evidence' :
               confidence >= 40 ? 'C — weak evidence' :
               confidence >= 20 ? 'D — insufficient evidence' :
               'F — no evidence',
        reasoning,
        evidenceSummary: {
          findings: mentionedFindings.slice(0, 5),
          sessionCount: mentionedSessions.length
        }
      }, null, 2)
    }

    return `Unknown tool: ${toolName}`
  },

  verify: async (context) => {
    const { state } = context
    const sessions = state.sessions || []
    const seed = loadActuators()
    const findings = state.knowledgeBase?.keyFindings || []

    if (sessions.length >= 5 && seed.length > 0) {
      const withTokens = sessions.filter(s => s.tokens?.input || s.tokens?.output).length
      return {
        operational: true,
        evidence: `${sessions.length} sessions (${withTokens} with token data), ${seed.length} actuators, ${findings.length} findings`
      }
    }

    return {
      operational: false,
      evidence: `Need 5+ sessions and actuator data (have ${sessions.length} sessions, ${seed.length} actuators)`
    }
  }
}
