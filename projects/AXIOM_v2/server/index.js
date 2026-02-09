import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { resolve, dirname } from 'node:path'
import { unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AVAILABLE_MODELS, executeCall, executeCallWithTools } from './claude-client.js'
import { buildShellPrompt, buildProposalChatPrompt } from './prompts.js'
import { loadState, saveState, setCapabilityStage } from './state.js'
import { loadCapabilities, getAllTools, getAllModules, executeAnyToolCall, verifyAll } from './capabilities/registry.js'
import { SHELL_TOOLS, executeShellTool } from './shell-tools.js'
import { initProposalCounter, approveProposal, rejectProposal, getPendingProposals, getAllProposals, getProposal } from './proposal-manager.js'
import { runPipeline, runImplementPhase, runAutoSelect, isPipelineActive, getPipelineStatus, getSelectorStatus, abortPipeline } from './pipeline-engine.js'
import { verifyCapability } from './verification-engine.js'
import { parseWhatsAppReply } from './whatsapp-bridge.js'
import { VALUES } from '../shared/identity.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_PATH = resolve(__dirname, 'data', 'state.json')

const app = express()
const PORT = process.env.PORT || 3102

app.use(cors())
app.use(express.json())

// Request logging
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`)
  })
  next()
})

// Init capabilities on startup
let capabilitiesLoaded = false
async function ensureCapabilities() {
  if (!capabilitiesLoaded) {
    await loadCapabilities()
    const state = loadState(STATE_PATH)
    initProposalCounter(state)
    capabilitiesLoaded = true
  }
}

// ===== HEALTH =====
app.get('/api/v2/health', async (req, res) => {
  const hasKey = !!process.env.ANTHROPIC_API_KEY
  res.json({
    ok: hasKey,
    models: AVAILABLE_MODELS,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    pipelineActive: isPipelineActive()
  })
})

// ===== STATE =====
app.get('/api/v2/state', (req, res) => {
  res.json(loadState(STATE_PATH))
})

app.get('/api/v2/state/summary', (req, res) => {
  const state = loadState(STATE_PATH)

  const valueSummary = {}
  let totalCaps = 0, totalVerified = 0, totalInPipeline = 0
  for (const [id, v] of Object.entries(state.values)) {
    const caps = Object.entries(v.capabilities || {})
    const verified = caps.filter(([, c]) => c.stage === 'verified').length
    const inPipeline = caps.filter(([, c]) => !['pending', 'verified'].includes(c.stage)).length
    valueSummary[id] = { score: v.score, total: caps.length, verified, inPipeline }
    totalCaps += caps.length
    totalVerified += verified
    totalInPipeline += inPipeline
  }

  const pending = getPendingProposals(state)

  res.json({
    sessionCount: state.sessionCount,
    totalCaps,
    totalVerified,
    totalInPipeline,
    pendingApproval: pending.length,
    values: valueSummary,
    pipelineActive: isPipelineActive(),
    lastSession: state.sessions.length > 0
      ? { id: state.sessions.at(-1).id, timestamp: state.sessions.at(-1).timestamp, type: state.sessions.at(-1).type }
      : null
  })
})

// ===== VALUES =====
app.get('/api/v2/values', (req, res) => {
  const state = loadState(STATE_PATH)

  const values = {}
  for (const [id, v] of Object.entries(state.values)) {
    const meta = VALUES[id] || {}
    values[id] = {
      ...meta,
      score: v.score,
      capabilities: v.capabilities || {}
    }
  }

  res.json(values)
})

// ===== PROPOSALS =====
app.get('/api/v2/proposals', (req, res) => {
  const state = loadState(STATE_PATH)
  res.json(getAllProposals(state))
})

app.post('/api/v2/proposals/:id/approve', async (req, res) => {
  const state = loadState(STATE_PATH)
  const result = approveProposal(state, STATE_PATH, req.params.id)
  res.json(result)

  // Auto-trigger implement phase in the background
  if (result.success && !isPipelineActive()) {
    await ensureCapabilities()
    console.log(`[Pipeline] Auto-implementing after approval: ${req.params.id}`)
    runImplementPhase(STATE_PATH, req.params.id, (evt) => {
      console.log(`[Pipeline] ${evt.type}${evt.phase ? ' (' + evt.phase + ')' : ''}`)
    }).catch(err => console.error(`[Pipeline] Auto-implement error: ${err.message}`))
  }
})

app.post('/api/v2/proposals/:id/reject', (req, res) => {
  const state = loadState(STATE_PATH)
  const { reason } = req.body
  const result = rejectProposal(state, STATE_PATH, req.params.id, reason)
  res.json(result)
})

app.post('/api/v2/proposals/:id/retry-implement', async (req, res) => {
  if (isPipelineActive()) {
    return res.json({ success: false, error: 'Pipeline already running' })
  }

  const state = loadState(STATE_PATH)
  const proposal = (state.proposals || []).find(p => p.id === req.params.id)
  if (!proposal) {
    return res.status(404).json({ success: false, error: `Proposal ${req.params.id} not found` })
  }
  if (proposal.status === 'pending_approval' || proposal.status === 'rejected') {
    return res.json({ success: false, error: `Cannot retry: proposal is ${proposal.status}` })
  }
  if (proposal.status === 'verified') {
    return res.json({ success: false, error: 'Already verified' })
  }

  // Reset proposal and capability state for fresh implementation
  proposal.status = 'approved'
  const { capabilityId, valueId } = proposal
  setCapabilityStage(state, valueId, capabilityId, 'approved')

  // Remove old capability module so verification uses the fresh one
  const capFile = resolve(__dirname, `capabilities/${capabilityId}.js`)
  try { unlinkSync(capFile) } catch {}

  saveState(STATE_PATH, state)
  console.log(`[Pipeline] Retry implementation for ${capabilityId} (proposal ${req.params.id})`)
  res.json({ success: true, capabilityId, valueId })

  // Fire implementation in background
  await ensureCapabilities()
  runImplementPhase(STATE_PATH, req.params.id, (evt) => {
    console.log(`[Pipeline] ${evt.type}${evt.phase ? ' (' + evt.phase + ')' : ''}`)
  }).catch(err => console.error(`[Pipeline] Retry-implement error: ${err.message}`))
})

// ===== PROPOSAL Q&A =====
app.post('/api/v2/proposals/:id/chat', async (req, res) => {
  const { message, history } = req.body

  if (!message) {
    return res.status(400).json({ success: false, error: 'Missing required field: message' })
  }

  const state = loadState(STATE_PATH)
  const proposal = getProposal(state, req.params.id)
  if (!proposal) {
    return res.status(404).json({ success: false, error: `Proposal ${req.params.id} not found` })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch {}
  }

  try {
    const systemPrompt = buildProposalChatPrompt(proposal, state)

    const messages = []
    if (history && Array.isArray(history)) {
      for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content })
      }
    }
    messages.push({ role: 'user', content: message })

    console.log(`[Proposal Chat] ${req.params.id}: "${message.slice(0, 80)}"`)

    const result = await executeCall({
      model: 'sonnet',
      systemPrompt,
      maxTokens: 1024,
      messages
    })

    if (result.success) {
      sendEvent({
        type: 'response',
        text: result.result,
        tokens: result.tokens,
        duration: result.duration
      })
      console.log(`  -> OK (${result.tokens.total} tokens, ${result.duration}ms)`)
    } else {
      sendEvent({ type: 'error', error: result.error })
      console.log(`  -> FAIL: ${result.error}`)
    }
  } catch (err) {
    console.error('Proposal chat error:', err)
    sendEvent({ type: 'error', error: err.message })
  }

  res.write('data: [DONE]\n\n')
  res.end()
})

// ===== PIPELINE =====
app.post('/api/v2/pipeline/run', async (req, res) => {
  const { capabilityId, valueId } = req.body

  if (!capabilityId || !valueId) {
    return res.status(400).json({ success: false, error: 'Missing capabilityId or valueId' })
  }

  await ensureCapabilities()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch {}
  }

  try {
    const result = await runPipeline(STATE_PATH, capabilityId, valueId, sendEvent)
    sendEvent({ type: 'pipeline_done', ...result })
  } catch (err) {
    sendEvent({ type: 'pipeline_error', error: err.message })
  }

  res.write('data: [DONE]\n\n')
  res.end()
})

app.post('/api/v2/pipeline/run-auto', async (req, res) => {
  await ensureCapabilities()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch {}
  }

  try {
    const result = await runAutoSelect(STATE_PATH, sendEvent)
    sendEvent({ type: 'pipeline_done', ...result })
  } catch (err) {
    sendEvent({ type: 'pipeline_error', error: err.message })
  }

  res.write('data: [DONE]\n\n')
  res.end()
})

app.get('/api/v2/pipeline/active', (req, res) => {
  const pipeline = getPipelineStatus()
  const selector = getSelectorStatus()
  res.json({
    active: !!(pipeline || selector),
    pipeline: pipeline || selector
  })
})

// Abort running pipeline
app.post('/api/v2/pipeline/abort', (req, res) => {
  const result = abortPipeline()
  console.log(`[Pipeline] Abort requested: ${JSON.stringify(result)}`)
  res.json(result)
})

// Implement an approved proposal
app.post('/api/v2/pipeline/implement/:proposalId', async (req, res) => {
  await ensureCapabilities()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch {}
  }

  try {
    const result = await runImplementPhase(STATE_PATH, req.params.proposalId, sendEvent)
    sendEvent({ type: 'pipeline_done', ...result })
  } catch (err) {
    sendEvent({ type: 'pipeline_error', error: err.message })
  }

  res.write('data: [DONE]\n\n')
  res.end()
})

// ===== CAPABILITIES =====
app.get('/api/v2/capabilities', async (req, res) => {
  await ensureCapabilities()

  const state = loadState(STATE_PATH)
  const capTools = getAllTools()

  // Gather all capabilities from state
  const allCaps = []
  for (const [vid, v] of Object.entries(state.values)) {
    for (const [cid, cap] of Object.entries(v.capabilities || {})) {
      allCaps.push({ id: cid, valueId: vid, ...cap })
    }
  }

  res.json({
    phase0Tools: capTools.map(t => ({ name: t.name, description: t.description })),
    capabilities: allCaps
  })
})

// ===== VERIFICATION =====
app.post('/api/v2/verify/:capabilityId', async (req, res) => {
  await ensureCapabilities()

  const { capabilityId } = req.params
  const { valueId } = req.body

  if (!valueId) {
    return res.status(400).json({ success: false, error: 'Missing valueId in body' })
  }

  const state = loadState(STATE_PATH)
  const cap = state.values[valueId]?.capabilities?.[capabilityId]
  if (!cap) {
    return res.status(404).json({ success: false, error: `Capability ${capabilityId} not found in ${valueId}` })
  }

  // Look up proposal for verification spec
  const proposal = (state.proposals || []).find(p => p.capabilityId === capabilityId)
  const verificationSpec = proposal?.verification || {}

  const result = await verifyCapability(state, STATE_PATH, capabilityId, valueId, verificationSpec)

  // Sync proposal status with verification result
  if (proposal) {
    const freshState = loadState(STATE_PATH)
    const prop = (freshState.proposals || []).find(p => p.id === proposal.id)
    if (prop) {
      prop.status = result.success ? 'verified' : 'implemented'
      if (result.success) prop.verifiedAt = new Date().toISOString()
      saveState(STATE_PATH, freshState)
    }
  }

  res.json(result)
})

// ===== SHELL =====
app.get('/api/v2/shell/tools', async (req, res) => {
  await loadCapabilities()

  const modules = getAllModules()
  const registryTools = modules.flatMap(mod =>
    mod.tools.map(t => ({
      name: t.name,
      description: t.description,
      type: 'registry',
      capabilityId: mod.id,
      valueId: mod.valueId
    }))
  )
  const tools = [
    ...SHELL_TOOLS.map(t => ({ name: t.name, description: t.description, type: 'operator' })),
    ...registryTools
  ]

  res.json({ tools })
})

app.post('/api/v2/shell/chat', async (req, res) => {
  const { message, history } = req.body

  if (!message) {
    return res.status(400).json({ success: false, error: 'Missing required field: message' })
  }

  await loadCapabilities()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch {}
  }

  try {
    const state = loadState(STATE_PATH)
    const registryTools = getAllTools()

    const shellContext = {
      state,
      statePath: STATE_PATH,
      runPipelineFn: (capId, valId) => runPipeline(STATE_PATH, capId, valId, sendEvent)
    }

    const shellToolDescriptions = SHELL_TOOLS.map(t => `- ${t.name}: ${t.description} [operator]`)
    const registryDescriptions = registryTools.map(t => `- ${t.name}: ${t.description}`)
    const allDescriptions = [...shellToolDescriptions, ...registryDescriptions]

    const systemPrompt = buildShellPrompt(state) + '\n\n' + allDescriptions.join('\n')

    const messages = []
    if (history && Array.isArray(history)) {
      for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content })
      }
    }
    messages.push({ role: 'user', content: message })

    const shellToolSchemas = SHELL_TOOLS.map(t => ({
      name: t.name, description: t.description, input_schema: t.input_schema
    }))
    const registryToolSchemas = registryTools.map(t => ({
      name: t.name, description: t.description, input_schema: t.input_schema
    }))
    const allToolSchemas = [...shellToolSchemas, ...registryToolSchemas]
    const shellToolNames = new Set(SHELL_TOOLS.map(t => t.name))

    const serverTools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]

    sendEvent({ type: 'thinking', text: 'Processing...' })

    console.log(`[Shell] "${message.slice(0, 80)}..." (${allToolSchemas.length} tools)`)

    const result = await executeCallWithTools({
      model: 'opus',
      systemPrompt,
      maxTokens: 4096,
      serverTools,
      capabilityTools: allToolSchemas,
      toolExecutor: (name, input) => {
        if (shellToolNames.has(name)) {
          return executeShellTool(name, input, shellContext)
        }
        return executeAnyToolCall(name, input)
      },
      maxToolRounds: 8,
      messages,
      onToolEvent: sendEvent
    })

    if (result.success) {
      sendEvent({
        type: 'response',
        text: result.result,
        tokens: result.tokens,
        toolInvocations: result.toolInvocations || [],
        searchCount: result.searchCount || 0,
        duration: result.duration
      })
      console.log(`  -> OK (${result.tokens.total} tokens, ${result.duration}ms, ${result.toolInvocations?.length || 0} tool calls)`)
    } else {
      sendEvent({ type: 'error', error: result.error })
      console.log(`  -> FAIL: ${result.error}`)
    }
  } catch (err) {
    console.error('Shell chat error:', err)
    sendEvent({ type: 'error', error: err.message })
  }

  res.write('data: [DONE]\n\n')
  res.end()
})

// ===== WHATSAPP WEBHOOK =====
app.post('/api/v2/whatsapp/webhook', (req, res) => {
  const { text, proposalId } = req.body

  if (!text || !proposalId) {
    return res.status(400).json({ success: false, error: 'Missing text or proposalId' })
  }

  const parsed = parseWhatsAppReply(text)
  const state = loadState(STATE_PATH)

  if (parsed.action === 'approve') {
    const result = approveProposal(state, STATE_PATH, proposalId)
    return res.json(result)
  }
  if (parsed.action === 'reject') {
    const result = rejectProposal(state, STATE_PATH, proposalId, parsed.reason)
    return res.json(result)
  }

  res.json({ success: false, error: 'Could not parse reply. Reply YES or NO.' })
})

// Startup
app.listen(PORT, async () => {
  console.log(`AXIOM v2 API running on port ${PORT}`)
  console.log(`API key configured: ${!!process.env.ANTHROPIC_API_KEY}`)
  await ensureCapabilities()

  // Recover capabilities stuck mid-pipeline from a crash/restart
  const state = loadState(STATE_PATH)
  let recovered = 0
  for (const [valueId, v] of Object.entries(state.values)) {
    for (const [capId, cap] of Object.entries(v.capabilities || {})) {
      if (cap.stage === 'implementing') {
        console.log(`[Recovery] ${capId} stuck at 'implementing' — resetting to 'approved'`)
        cap.stage = 'approved'
        recovered++
      }
    }
  }
  if (recovered > 0) {
    saveState(STATE_PATH, state)
    console.log(`[Recovery] Reset ${recovered} stuck capability(s)`)
  }

  console.log('Ready.')
})
