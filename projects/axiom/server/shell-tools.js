// Always-on operator tools for the AXIOM Shell
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSession } from './session-runner.js'
import { loadState, saveState, nextSessionId, mergeKnowledgeUpdates } from './state.js'
import { getAllModules, getActiveTools } from './capabilities/registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const SHELL_TOOLS = [
  {
    name: 'trigger_session',
    description: 'Start an autonomous AXIOM research session. Long-running (30-120s). Returns session results when complete.',
    input_schema: {
      type: 'object',
      properties: {
        sessionType: {
          type: 'string',
          enum: ['auto', 'literature', 'status', 'experiment'],
          description: 'Type of session to run. Default: auto'
        }
      },
      required: []
    }
  },
  {
    name: 'lookup_actuator',
    description: 'Query the actuator taxonomy. Filters can be combined. Returns matched actuators with full details and operational status.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Exact actuator ID to look up' },
        query: { type: 'string', description: 'Free-text search across name/description' },
        category: { type: 'string', description: 'Filter by category (physical, cognitive, social, digital, economic, informational, meta)' },
        status: { type: 'string', description: 'Filter by status (confirmed, theoretical, blocked, distant, impossible)' }
      },
      required: []
    }
  },
  {
    name: 'get_session_detail',
    description: 'Get full details of a past research session including director plan, findings, synthesis, and token usage.',
    input_schema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID, e.g. "session-042"' }
      },
      required: ['sessionId']
    }
  },
  {
    name: 'update_knowledge',
    description: 'Update AXIOM knowledge base. Can add findings, change actuator statuses, or revise feasibility scores.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['finding', 'status', 'feasibility'],
          description: 'Type of update'
        },
        actuatorId: { type: 'string', description: 'Actuator ID (required for status and feasibility updates)' },
        value: { type: 'string', description: 'The value to set — finding text, status string, or feasibility number' },
        reason: { type: 'string', description: 'Brief justification for the update' }
      },
      required: ['type', 'value']
    }
  },
  {
    name: 'list_all_capabilities',
    description: 'List all capability registry modules with their tools, active/inactive status, and usage counts.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  }
]

/**
 * Execute a shell tool.
 * @param {string} name - Tool name
 * @param {object} input - Tool input
 * @param {object} context - { state, statePath, getActiveSession, setActiveSession, seedActuators, registryModules }
 * @returns {string} Result text
 */
export async function executeShellTool(name, input, context) {
  const { state, statePath, getActiveSession, setActiveSession, seedActuators, registryModules } = context

  switch (name) {
    case 'trigger_session':
      return await handleTriggerSession(input, context)
    case 'lookup_actuator':
      return handleLookupActuator(input, context)
    case 'get_session_detail':
      return handleGetSessionDetail(input, context)
    case 'update_knowledge':
      return handleUpdateKnowledge(input, context)
    case 'list_all_capabilities':
      return handleListCapabilities(input, context)
    default:
      return `Error: unknown shell tool "${name}"`
  }
}

async function handleTriggerSession(input, context) {
  const { state, statePath, getActiveSession, setActiveSession } = context
  const sessionType = input.sessionType || 'auto'

  if (getActiveSession()) {
    return `Error: a session is already running (${JSON.stringify(getActiveSession())}). Wait for it to complete.`
  }

  setActiveSession({ sessionType, startedAt: new Date().toISOString(), source: 'shell' })

  try {
    const freshState = loadState(statePath)
    const startTime = Date.now()

    const { session, knowledgeUpdates, error } = await runSession(freshState, {
      sessionType,
      verbose: true
    })

    if (error) {
      return `Session failed: ${error}`
    }

    session.id = nextSessionId(freshState)
    freshState.sessionCount++
    freshState.sessions.push(session)
    mergeKnowledgeUpdates(freshState, knowledgeUpdates)
    saveState(statePath, freshState)

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1)
    const totalTokens = (session.tokens?.input || 0) + (session.tokens?.output || 0)

    console.log(`[Shell:trigger_session] ${session.id} completed in ${durationSec}s (${totalTokens} tokens)`)

    return JSON.stringify({
      sessionId: session.id,
      type: sessionType,
      durationSeconds: parseFloat(durationSec),
      tokens: totalTokens,
      searchCount: session.searchCount || 0,
      findingsCount: knowledgeUpdates.keyFindings.length,
      synthesisExcerpt: (session.synthesis || '').slice(0, 800)
    }, null, 2)
  } finally {
    setActiveSession(null)
  }
}

function handleLookupActuator(input, context) {
  const { seedActuators, state } = context
  const kb = state.knowledgeBase || {}

  // Merge seed data with state overrides
  const allActuators = seedActuators.map(a => {
    const runtimeStatus = kb.confirmedActuators?.[a.id] || kb.actuatorStatuses?.[a.id] || a.status
    const revisedFeasibility = kb.revisedFeasibility?.[a.id]
    const opCap = kb.operationalCapabilities?.[a.id]
    return {
      ...a,
      status: runtimeStatus,
      feasibility: revisedFeasibility ?? a.feasibility,
      operational: opCap || null
    }
  })

  // Add discovered actuators
  const discovered = kb.discoveredActuators || []
  for (const d of discovered) {
    if (typeof d === 'string') continue
    if (allActuators.some(a => a.id === d.id)) continue
    const runtimeStatus = kb.confirmedActuators?.[d.id] || kb.actuatorStatuses?.[d.id] || d.status
    const revisedFeasibility = kb.revisedFeasibility?.[d.id]
    const opCap = kb.operationalCapabilities?.[d.id]
    allActuators.push({
      ...d,
      status: runtimeStatus,
      feasibility: revisedFeasibility ?? d.feasibility,
      operational: opCap || null,
      discovered: true
    })
  }

  // Apply filters
  let results = allActuators

  if (input.id) {
    results = results.filter(a => a.id === input.id)
  }
  if (input.category) {
    results = results.filter(a => a.category === input.category)
  }
  if (input.status) {
    results = results.filter(a => a.status === input.status)
  }
  if (input.query) {
    const q = input.query.toLowerCase()
    results = results.filter(a =>
      a.name.toLowerCase().includes(q) ||
      (a.description || '').toLowerCase().includes(q) ||
      a.id.toLowerCase().includes(q)
    )
  }

  if (results.length === 0) {
    return 'No actuators matched the given filters.'
  }

  return JSON.stringify(results, null, 2)
}

function handleGetSessionDetail(input, context) {
  const { state } = context
  const { sessionId } = input

  const session = state.sessions.find(s => s.id === sessionId)
  if (!session) {
    const available = state.sessions.slice(-10).map(s => s.id).join(', ')
    return `Session "${sessionId}" not found. Recent sessions: ${available || 'none'}`
  }

  // Truncate findings if too large
  const findings = (session.findings || []).map(f => {
    if (typeof f === 'string' && f.length > 500) {
      return f.slice(0, 500) + '... [truncated]'
    }
    return f
  })

  const detail = {
    id: session.id,
    timestamp: session.timestamp,
    type: session.type,
    directorPlan: (session.directorPlan || '').slice(0, 2000),
    findings,
    synthesis: (session.synthesis || '').slice(0, 2000),
    proposedUpdates: session.proposedUpdates || [],
    tokens: session.tokens,
    searchCount: session.searchCount || 0,
    toolUsage: session.toolUsage || [],
    durationMs: session.durationMs
  }

  const serialized = JSON.stringify(detail, null, 2)

  // If still too large, truncate findings more aggressively
  if (serialized.length > 15000) {
    detail.findings = findings.map(f =>
      typeof f === 'string' && f.length > 200 ? f.slice(0, 200) + '... [truncated]' : f
    )
    detail.directorPlan = (session.directorPlan || '').slice(0, 1000) + '... [truncated]'
    detail.synthesis = (session.synthesis || '').slice(0, 1000) + '... [truncated]'
    return JSON.stringify(detail, null, 2)
  }

  return serialized
}

function handleUpdateKnowledge(input, context) {
  const { state, statePath } = context
  const { type, actuatorId, value, reason } = input
  const kb = state.knowledgeBase

  const prefix = '[Shell:update_knowledge]'

  switch (type) {
    case 'finding': {
      kb.keyFindings.push(value)
      saveState(statePath, state)
      console.log(`${prefix} Added finding: "${value.slice(0, 80)}"`)
      return JSON.stringify({
        success: true,
        type: 'finding',
        value,
        totalFindings: kb.keyFindings.length
      })
    }

    case 'status': {
      if (!actuatorId) {
        return 'Error: actuatorId is required for status updates'
      }
      const confirmed = kb.confirmedActuators || {}
      if (confirmed[actuatorId] === 'confirmed') {
        return `Error: "${actuatorId}" is already confirmed — cannot overwrite confirmed status`
      }
      const oldStatus = kb.actuatorStatuses?.[actuatorId] || 'unset'
      if (!kb.actuatorStatuses) kb.actuatorStatuses = {}
      kb.actuatorStatuses[actuatorId] = value
      saveState(statePath, state)
      console.log(`${prefix} Status ${actuatorId}: ${oldStatus} → ${value}${reason ? ` (${reason})` : ''}`)
      return JSON.stringify({
        success: true,
        type: 'status',
        actuatorId,
        oldValue: oldStatus,
        newValue: value,
        reason: reason || null
      })
    }

    case 'feasibility': {
      if (!actuatorId) {
        return 'Error: actuatorId is required for feasibility updates'
      }
      const numValue = parseFloat(value)
      if (isNaN(numValue) || numValue < 0.0 || numValue > 1.0) {
        return `Error: feasibility must be a number between 0.0 and 1.0, got "${value}"`
      }
      const oldFeasibility = kb.revisedFeasibility?.[actuatorId] || 'unset'
      if (!kb.revisedFeasibility) kb.revisedFeasibility = {}
      kb.revisedFeasibility[actuatorId] = numValue
      saveState(statePath, state)
      console.log(`${prefix} Feasibility ${actuatorId}: ${oldFeasibility} → ${numValue}${reason ? ` (${reason})` : ''}`)
      return JSON.stringify({
        success: true,
        type: 'feasibility',
        actuatorId,
        oldValue: oldFeasibility,
        newValue: numValue,
        reason: reason || null
      })
    }

    default:
      return `Error: unknown update type "${type}". Must be: finding, status, feasibility`
  }
}

function handleListCapabilities(input, context) {
  const { registryModules, state } = context
  const opCaps = state.knowledgeBase?.operationalCapabilities || {}
  const confirmed = state.knowledgeBase?.confirmedActuators || {}
  const statuses = state.knowledgeBase?.actuatorStatuses || {}

  const activeToolNames = new Set(getActiveTools().map(t => t.name))

  const modules = registryModules.map(mod => {
    const ids = Array.isArray(mod.actuatorId) ? mod.actuatorId : [mod.actuatorId]
    const isActive = mod.tools.some(t => activeToolNames.has(t.name))
    return {
      actuatorIds: ids,
      active: isActive,
      tools: mod.tools.map(t => ({ name: t.name, description: t.description })),
      statuses: ids.map(id => ({
        id,
        status: confirmed[id] || statuses[id] || 'unknown',
        usage: opCaps[id] || null
      }))
    }
  })

  return JSON.stringify({
    totalModules: registryModules.length,
    activeCount: modules.filter(m => m.active).length,
    modules
  }, null, 2)
}
