import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { readFileSync } from 'node:fs'
import { executeCall, executeCallStream, executeCallWithTools, AVAILABLE_MODELS } from './claude-client.js'
import { buildSystemPrompt, buildShellPrompt } from './prompts.js'
import { loadState, saveState, nextSessionId, mergeKnowledgeUpdates } from './state.js'
import { runSession } from './session-runner.js'
import { loadCapabilities, initRegistry, verifyAll, getActiveTools, getAllTools, getActiveToolDescriptions, executeToolCall, executeAnyToolCall, getAllModules } from './capabilities/registry.js'
import { SHELL_TOOLS, executeShellTool } from './shell-tools.js'
import { DIRECTORS, DEFAULT_DIRECTOR } from '../shared/identity.js'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_PATH = resolve(__dirname, 'data', 'state.json')

const app = express()
const PORT = process.env.PORT || 3101

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

// Bearer token auth
const API_TOKEN = process.env.CC_API_TOKEN
function authMiddleware(req, res, next) {
  if (!API_TOKEN) return next()
  const auth = req.headers.authorization
  if (auth !== `Bearer ${API_TOKEN}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }
  next()
}

app.use('/api/execute', authMiddleware)
app.use('/api/route', authMiddleware)
app.use('/api/session', authMiddleware)
// Shell routes are browser-accessed behind nginx basic auth — no Bearer token needed

// Concurrency guard for real sessions
let activeSession = null
function getActiveSession() { return activeSession }
function setActiveSession(v) { activeSession = v }

// Session state
const missions = new Map()

function getMissionContext(missionId, unitId) {
  if (!missionId) return null
  const mission = missions.get(missionId)
  if (!mission) return null
  return mission.units.get(unitId) || null
}

function storeMissionResult(missionId, unitId, result, summary) {
  if (!missionId) return
  if (!missions.has(missionId)) {
    missions.set(missionId, { units: new Map(), objective: '' })
  }
  const mission = missions.get(missionId)
  if (!mission.units.has(unitId)) {
    mission.units.set(unitId, { messages: [], summary: '' })
  }
  const unitCtx = mission.units.get(unitId)
  unitCtx.messages.push({ role: 'assistant', content: result })
  unitCtx.summary = summary || result.slice(0, 500)
}

// Health check
app.get('/api/health', (req, res) => {
  const hasKey = !!process.env.ANTHROPIC_API_KEY
  res.json({
    status: hasKey ? 'ok' : 'no_api_key',
    models: AVAILABLE_MODELS,
    uptime: process.uptime()
  })
})

// CLI state — full
app.get('/api/state', (req, res) => {
  const state = loadState(STATE_PATH)
  res.json(state)
})

// CLI state — lightweight polling summary
app.get('/api/state/summary', (req, res) => {
  const state = loadState(STATE_PATH)
  const lastSession = state.sessions.length > 0
    ? (() => { const s = state.sessions[state.sessions.length - 1]; return { id: s.id, timestamp: s.timestamp, type: s.type } })()
    : null
  res.json({
    sessionCount: state.sessionCount,
    totalTokens: state.sessions.reduce((sum, s) => sum + (s.tokens?.input || 0) + (s.tokens?.output || 0), 0),
    totalSearches: state.sessions.reduce((sum, s) => sum + (s.searchCount || 0), 0),
    findingsCount: state.knowledgeBase?.keyFindings?.length || 0,
    revisedFeasibility: state.knowledgeBase?.revisedFeasibility || {},
    actuatorStatuses: {
      ...(state.knowledgeBase?.actuatorStatuses || {}),
      ...(state.knowledgeBase?.confirmedActuators || {})
    },
    lastSession,
    discoveredActuators: state.knowledgeBase?.discoveredActuators || [],
    operationalCapabilities: state.knowledgeBase?.operationalCapabilities || {}
  })
})

// Execute a task via Claude API
app.post('/api/execute', async (req, res) => {
  const { unit, task, model, tools, missionId, previousContext } = req.body

  if (!unit || !task || !model) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: unit, task, model'
    })
  }

  if (!AVAILABLE_MODELS.includes(model)) {
    return res.status(400).json({
      success: false,
      error: `Invalid model: ${model}. Available: ${AVAILABLE_MODELS.join(', ')}`
    })
  }

  const systemPrompt = buildSystemPrompt(unit, task.context || '')

  let userMessage = task.description
  if (previousContext) {
    userMessage = `Previous findings from other agents:\n\n${previousContext}\n\n---\n\nYour task: ${task.description}`
  }

  let messages
  const missionCtx = getMissionContext(missionId, unit.id)
  if (missionCtx && missionCtx.messages.length > 0) {
    messages = []
    for (const msg of missionCtx.messages) {
      messages.push({ role: 'user', content: 'Continue with the session.' })
      messages.push(msg)
    }
    messages.push({ role: 'user', content: userMessage })
  }

  console.log(`[Execute] ${unit.name} (${model}) — ${userMessage.slice(0, 80)}...`)
  if (tools?.length) console.log(`  [Tools] ${tools.map(t => t.type || t.name).join(', ')}`)

  const result = await executeCall({
    model,
    systemPrompt,
    userMessage,
    maxTokens: model === 'haiku' ? 512 : model === 'sonnet' ? 1024 : 2048,
    tools: tools || undefined,
    messages
  })

  if (result.success) {
    console.log(`  -> OK (${result.tokens.total} tokens, ${result.duration}ms${result.searchCount ? `, ${result.searchCount} searches` : ''})`)
    storeMissionResult(missionId, unit.id, result.result, result.result.slice(0, 500))
  } else {
    console.log(`  -> FAIL: ${result.error}`)
  }

  res.json(result)
})

// Streaming execute endpoint
app.post('/api/execute/stream', async (req, res) => {
  const { unit, task, model, tools, missionId, previousContext } = req.body

  if (!unit || !task || !model) {
    res.status(400).json({ success: false, error: 'Missing required fields' })
    return
  }

  if (!AVAILABLE_MODELS.includes(model)) {
    res.status(400).json({ success: false, error: `Invalid model: ${model}` })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const systemPrompt = buildSystemPrompt(unit, task.context || '')

  let userMessage = task.description
  if (previousContext) {
    userMessage = `Previous findings from other agents:\n\n${previousContext}\n\n---\n\nYour task: ${task.description}`
  }

  let messages
  const missionCtx = getMissionContext(missionId, unit.id)
  if (missionCtx && missionCtx.messages.length > 0) {
    messages = []
    for (const msg of missionCtx.messages) {
      messages.push({ role: 'user', content: 'Continue with the session.' })
      messages.push(msg)
    }
    messages.push({ role: 'user', content: userMessage })
  }

  console.log(`[Stream] ${unit.name} (${model}) — ${userMessage.slice(0, 80)}...`)

  let fullText = ''

  try {
    for await (const event of executeCallStream({
      model,
      systemPrompt,
      userMessage,
      maxTokens: model === 'haiku' ? 512 : model === 'sonnet' ? 1024 : 2048,
      tools: tools || undefined,
      messages
    })) {
      res.write(`data: ${JSON.stringify(event)}\n\n`)

      if (event.type === 'text_delta') {
        fullText += event.text
      }

      if (event.type === 'done') {
        storeMissionResult(missionId, unit.id, fullText, fullText.slice(0, 500))
        console.log(`  -> OK (${event.tokens.total} tokens, ${event.duration}ms)`)
      }

      if (event.type === 'error') {
        console.log(`  -> FAIL: ${event.error}`)
      }
    }
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`)
  }

  res.write('data: [DONE]\n\n')
  res.end()
})

// LLM-Based Routing
app.post('/api/route', async (req, res) => {
  const { message } = req.body

  if (!message) {
    return res.status(400).json({
      success: false,
      error: 'Missing required field: message'
    })
  }

  const directorList = Object.entries(DIRECTORS)
    .map(([id, d]) => `- ${id}: ${d.specialty}`)
    .join('\n')

  const routingPrompt = `You are an AXIOM task router. Given these directors and their specialties, assign the incoming task to the best one.

Directors:
${directorList}

Task: "${message}"

Respond with ONLY valid JSON (no markdown, no explanation):
{"directorId": "<id>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}`

  try {
    const result = await executeCall({
      model: 'haiku',
      systemPrompt: 'You are a task routing system. Respond only with valid JSON.',
      userMessage: routingPrompt,
      maxTokens: 150
    })

    if (result.success) {
      try {
        const parsed = JSON.parse(result.result.trim())
        const validIds = Object.keys(DIRECTORS)
        if (!validIds.includes(parsed.directorId)) {
          parsed.directorId = DEFAULT_DIRECTOR
          parsed.reasoning = (parsed.reasoning || '') + ' (corrected: invalid directorId)'
        }
        res.json({
          generalId: parsed.directorId,
          confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
          reasoning: parsed.reasoning || 'LLM routing decision',
          llmRouted: true,
          tokens: result.tokens?.total || 0
        })
        return
      } catch {
        console.log('  [Route] Failed to parse LLM response, falling back to keywords')
      }
    }
  } catch (error) {
    console.log(`  [Route] LLM error: ${error.message}, falling back to keywords`)
  }

  // Keyword fallback
  const ROUTING_KEYWORDS = Object.fromEntries(
    Object.entries(DIRECTORS).map(([id, d]) => [id, d.keywords])
  )

  const lowerMessage = message.toLowerCase()
  let bestMatch = { generalId: DEFAULT_DIRECTOR, confidence: 0.3, reasoning: 'Default assignment' }

  for (const [directorId, keywords] of Object.entries(ROUTING_KEYWORDS)) {
    const matched = keywords.filter(kw => lowerMessage.includes(kw))
    const confidence = Math.min(matched.length / 3, 1.0)
    if (confidence > bestMatch.confidence) {
      bestMatch = {
        generalId: directorId,
        confidence: Math.round(confidence * 100) / 100,
        reasoning: `Keyword fallback — matched: ${matched.join(', ')}`
      }
    }
  }

  bestMatch.llmRouted = false
  res.json(bestMatch)
})

// Real session via SSE
app.get('/api/session/active', (req, res) => {
  res.json({ active: !!activeSession, session: activeSession })
})

app.post('/api/session/run', async (req, res) => {
  const { sessionType } = req.body
  const validTypes = ['auto', 'literature', 'status', 'experiment']

  if (!sessionType || !validTypes.includes(sessionType)) {
    return res.status(400).json({ success: false, error: `Invalid sessionType. Must be one of: ${validTypes.join(', ')}` })
  }

  if (activeSession) {
    return res.status(409).json({ success: false, error: 'A session is already running', session: activeSession })
  }

  activeSession = { sessionType, startedAt: new Date().toISOString() }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch { /* client disconnected */ }
  }

  try {
    const state = loadState(STATE_PATH)

    const { session, knowledgeUpdates, error } = await runSession(state, {
      sessionType,
      verbose: true,
      onEvent: sendEvent
    })

    if (error) {
      sendEvent({ type: 'error', error })
    } else {
      session.id = nextSessionId(state)
      state.sessionCount++
      state.sessions.push(session)
      mergeKnowledgeUpdates(state, knowledgeUpdates)
      saveState(STATE_PATH, state)
      sendEvent({ type: 'session_saved', sessionId: session.id, sessionCount: state.sessionCount })
    }
  } catch (err) {
    console.error('Session run error:', err)
    sendEvent({ type: 'error', error: err.message })
  } finally {
    activeSession = null
    res.write('data: [DONE]\n\n')
    res.end()
  }
})

// Session management
app.post('/api/mission/start', authMiddleware, (req, res) => {
  const { missionId, objective } = req.body
  if (!missionId) {
    return res.status(400).json({ success: false, error: 'Missing missionId' })
  }
  missions.set(missionId, { units: new Map(), objective: objective || '' })
  res.json({ success: true, missionId })
})

app.get('/api/mission/:missionId/context/:unitId', authMiddleware, (req, res) => {
  const ctx = getMissionContext(req.params.missionId, req.params.unitId)
  res.json({ success: true, context: ctx })
})

// Capabilities endpoint
app.get('/api/capabilities', async (req, res) => {
  try {
    const state = loadState(STATE_PATH)
    await loadCapabilities()
    initRegistry(state)

    const activeTools = getActiveTools()
    const allModules = getAllModules()
    const opCaps = state.knowledgeBase?.operationalCapabilities || {}

    const modules = allModules.map(mod => {
      const ids = Array.isArray(mod.actuatorId) ? mod.actuatorId : [mod.actuatorId]
      const isActive = activeTools.some(t => mod.tools.some(mt => mt.name === t.name))
      return {
        actuatorIds: ids,
        active: isActive,
        tools: mod.tools.map(t => ({ name: t.name, description: t.description })),
        verification: ids.map(id => opCaps[id] || null)
      }
    })

    res.json({
      totalModules: allModules.length,
      activeCount: modules.filter(m => m.active).length,
      modules,
      operationalCapabilities: opCaps
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Shell tools manifest — dynamic list for the UI
app.get('/api/shell/tools', async (req, res) => {
  try {
    const state = loadState(STATE_PATH)
    await loadCapabilities()
    initRegistry(state)

    const registryTools = getAllTools()

    const tools = [
      ...SHELL_TOOLS.map(t => ({ name: t.name, description: t.description, type: 'operator' })),
      ...registryTools.map(t => ({ name: t.name, description: t.description, type: 'registry' }))
    ]

    res.json({ tools })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Shell chat — conversational interface to AXIOM
app.post('/api/shell/chat', async (req, res) => {
  const { message, history } = req.body

  if (!message) {
    return res.status(400).json({ success: false, error: 'Missing required field: message' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const sendEvent = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch { /* client disconnected */ }
  }

  try {
    const state = loadState(STATE_PATH)
    await loadCapabilities()
    initRegistry(state)

    const registryTools = getAllTools()

    // Load seed actuators for lookup_actuator
    const seedActuators = JSON.parse(readFileSync(resolve(__dirname, '../src/data/actuators.json'), 'utf-8'))
    const registryModules = getAllModules()

    // Build shell context for shell tool execution
    const shellContext = { state, statePath: STATE_PATH, getActiveSession, setActiveSession, seedActuators, registryModules }

    // Shell tool descriptions for the prompt — shell has full access to all registry tools
    const shellToolDescriptions = SHELL_TOOLS.map(t => `- ${t.name}: ${t.description} [operator]`)
    const registryDescriptions = registryTools.map(t => `- ${t.name}: ${t.description}`)
    const allDescriptions = [...shellToolDescriptions, ...registryDescriptions]

    const systemPrompt = buildShellPrompt(state, allDescriptions)

    // Build messages from history + new message
    const messages = []
    if (history && Array.isArray(history)) {
      for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content })
      }
    }
    messages.push({ role: 'user', content: message })

    // Combine shell tools + registry tools for the API
    const shellToolSchemas = SHELL_TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema
    }))
    const registryToolSchemas = registryTools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema
    }))
    const allToolSchemas = [...shellToolSchemas, ...registryToolSchemas]

    // Shell tool names for routing
    const shellToolNames = new Set(SHELL_TOOLS.map(t => t.name))

    // Server tools (web search)
    const serverTools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]

    sendEvent({ type: 'thinking', text: 'Processing...' })

    console.log(`[Shell] "${message.slice(0, 80)}..." (${allToolSchemas.length} tools: ${SHELL_TOOLS.length} shell + ${registryToolSchemas.length} registry)`)

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

app.listen(PORT, () => {
  console.log(`AXIOM API running on port ${PORT}`)
  console.log(`API key configured: ${!!process.env.ANTHROPIC_API_KEY}`)
})
