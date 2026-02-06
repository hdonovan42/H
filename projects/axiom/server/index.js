import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { executeCall, executeCallStream, AVAILABLE_MODELS } from './claude-client.js'
import { buildSystemPrompt } from './prompts.js'
import { loadState } from './state.js'
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
    hypothesisResults: state.knowledgeBase?.hypothesisResults || {},
    lastSession
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

  const routingPrompt = `You are an AXIOM task router. Given these directors and their specialties, assign the incoming task to the best one.

Directors:
- dir-research: Literature mining, taxonomy building, knowledge synthesis, paper analysis, data exploration
- dir-strategy: Session planning, priority assessment, risk evaluation, hypothesis ranking, feasibility analysis
- dir-experiment: Hypothesis testing, actuator acquisition, capability verification, experiment execution

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
        const validIds = ['dir-research', 'dir-strategy', 'dir-experiment']
        if (!validIds.includes(parsed.directorId)) {
          parsed.directorId = 'dir-research'
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
  const ROUTING_KEYWORDS = {
    'dir-research': ['search', 'literature', 'taxonomy', 'read', 'paper', 'analyse', 'analyze', 'find', 'gather', 'review', 'mine'],
    'dir-strategy': ['plan', 'prioritise', 'prioritize', 'assess', 'schedule', 'evaluate', 'strategy', 'rank', 'feasibility'],
    'dir-experiment': ['test', 'hypothesis', 'acquire', 'execute', 'verify', 'implement', 'experiment', 'build', 'run']
  }

  const lowerMessage = message.toLowerCase()
  let bestMatch = { generalId: 'dir-research', confidence: 0.3, reasoning: 'Default assignment' }

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

app.listen(PORT, () => {
  console.log(`AXIOM API running on port ${PORT}`)
  console.log(`API key configured: ${!!process.env.ANTHROPIC_API_KEY}`)
})
