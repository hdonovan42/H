// Operator tools for the AXIOM v2 Shell
import { loadState, saveState } from './state.js'
import { getPendingProposals, getAllProposals } from './proposal-manager.js'
import { isPipelineActive } from './pipeline-engine.js'
import { VALUES } from '../shared/identity.js'

export const SHELL_TOOLS = [
  {
    name: 'trigger_pipeline',
    description: 'Start the Learn/Evaluate pipeline for a specific capability. Long-running (30-120s). Returns when proposal is created.',
    input_schema: {
      type: 'object',
      properties: {
        capabilityId: { type: 'string', description: 'Capability ID, e.g. "sp-monitoring"' },
        valueId: { type: 'string', enum: Object.keys(VALUES), description: 'Parent value ID' }
      },
      required: ['capabilityId', 'valueId']
    }
  },
  {
    name: 'get_system_status',
    description: 'Get current system status including value scores, pipeline status, pending proposals, and recent sessions.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'query_capabilities',
    description: 'Query all capabilities across all values. Filter by valueId, stage, or search by ID.',
    input_schema: {
      type: 'object',
      properties: {
        valueId: { type: 'string', description: 'Filter by value ID' },
        stage: { type: 'string', description: 'Filter by stage (pending, learning, learned, evaluating, proposed, approved, implementing, implemented, verifying, verified)' },
        search: { type: 'string', description: 'Search capability IDs' }
      },
      required: []
    }
  },
  {
    name: 'list_proposals',
    description: 'List all proposals with their status. Filter by status.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: pending_approval, approved, rejected, all' }
      },
      required: []
    }
  },
  {
    name: 'add_knowledge',
    description: 'Add a finding to the knowledge base.',
    input_schema: {
      type: 'object',
      properties: {
        finding: { type: 'string', description: 'The finding to record' }
      },
      required: ['finding']
    }
  }
]

export async function executeShellTool(name, input, context) {
  const { state, statePath, runPipelineFn } = context

  switch (name) {
    case 'trigger_pipeline':
      return handleTriggerPipeline(input, context)
    case 'get_system_status':
      return handleGetStatus(context)
    case 'query_capabilities':
      return handleQueryCapabilities(input, context)
    case 'list_proposals':
      return handleListProposals(input, context)
    case 'add_knowledge':
      return handleAddKnowledge(input, context)
    default:
      return `Error: unknown shell tool "${name}"`
  }
}

async function handleTriggerPipeline(input, context) {
  const { capabilityId, valueId } = input
  const { runPipelineFn } = context

  if (isPipelineActive()) {
    return JSON.stringify({ error: 'Pipeline is already running', active: isPipelineActive() })
  }

  if (!runPipelineFn) {
    return 'Error: pipeline function not available in this context'
  }

  try {
    const result = await runPipelineFn(capabilityId, valueId)
    return JSON.stringify(result, null, 2)
  } catch (err) {
    return `Pipeline error: ${err.message}`
  }
}

function handleGetStatus(context) {
  const { state } = context
  const active = isPipelineActive()

  const valueStatus = {}
  for (const [id, v] of Object.entries(state.values)) {
    const caps = Object.entries(v.capabilities || {})
    const verified = caps.filter(([, c]) => c.stage === 'verified').length
    const inProgress = caps.filter(([, c]) => !['pending', 'verified'].includes(c.stage)).length
    valueStatus[id] = {
      name: VALUES[id]?.name,
      score: v.score,
      total: caps.length,
      verified,
      inProgress
    }
  }

  const pending = getPendingProposals(state)

  return JSON.stringify({
    goal: state.goal,
    sessionCount: state.sessionCount,
    pipelineActive: active,
    values: valueStatus,
    pendingProposals: pending.length,
    knowledgeFindings: (state.knowledgeBase?.keyFindings || []).length,
    verificationEntries: (state.verificationLog || []).length
  }, null, 2)
}

function handleQueryCapabilities(input, context) {
  const { state } = context
  const results = []

  for (const [vid, v] of Object.entries(state.values)) {
    if (input.valueId && vid !== input.valueId) continue
    for (const [cid, cap] of Object.entries(v.capabilities || {})) {
      if (input.stage && cap.stage !== input.stage) continue
      if (input.search && !cid.includes(input.search)) continue
      results.push({
        id: cid,
        valueId: vid,
        valueName: VALUES[vid]?.name,
        stage: cap.stage,
        evidence: cap.evidence?.slice(0, 200),
        proposalId: cap.proposalId,
        updatedAt: cap.updatedAt
      })
    }
  }

  return JSON.stringify({ count: results.length, capabilities: results }, null, 2)
}

function handleListProposals(input, context) {
  const { state } = context
  let proposals = getAllProposals(state)

  if (input.status && input.status !== 'all') {
    proposals = proposals.filter(p => p.status === input.status)
  }

  const summary = proposals.map(p => ({
    id: p.id,
    capabilityId: p.capabilityId,
    valueId: p.valueId,
    title: p.title,
    status: p.status,
    risk: p.risk,
    createdAt: p.createdAt
  }))

  return JSON.stringify({ count: summary.length, proposals: summary }, null, 2)
}

function handleAddKnowledge(input, context) {
  const { state, statePath } = context
  const { finding } = input

  if (!state.knowledgeBase) state.knowledgeBase = { keyFindings: [], implementedCapabilities: [] }
  state.knowledgeBase.keyFindings.push(finding)
  saveState(statePath, state)

  return JSON.stringify({
    success: true,
    totalFindings: state.knowledgeBase.keyFindings.length
  })
}
