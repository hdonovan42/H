import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { executeCall, executeCallStream, AVAILABLE_MODELS } from './claude-client.js'
import { buildSystemPrompt } from './prompts.js'

const app = express()
const PORT = process.env.PORT || 3100

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

// Bearer token auth — protects API from unauthorized access
const API_TOKEN = process.env.CC_API_TOKEN
function authMiddleware(req, res, next) {
  if (!API_TOKEN) return next()  // No token configured = no auth (local dev)
  const auth = req.headers.authorization
  if (auth !== `Bearer ${API_TOKEN}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }
  next()
}

app.use('/api/execute', authMiddleware)
app.use('/api/route', authMiddleware)

// --- Mission Session State (Step 5) ---
const missions = new Map()  // missionId → { units: Map(unitId → { messages: [], summary: '' }), objective: '' }

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
  // Keep summary as latest truncated result
  unitCtx.summary = summary || result.slice(0, 500)
}

// Health check (no auth required)
app.get('/api/health', (req, res) => {
  const hasKey = !!process.env.ANTHROPIC_API_KEY
  res.json({
    status: hasKey ? 'ok' : 'no_api_key',
    models: AVAILABLE_MODELS,
    uptime: process.uptime()
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

  // Build user message with optional previous context
  let userMessage = task.description
  if (previousContext) {
    userMessage = `Previous findings from other agents:\n\n${previousContext}\n\n---\n\nYour task: ${task.description}`
  }

  // Build messages array — support multi-turn from mission context
  let messages
  const missionCtx = getMissionContext(missionId, unit.id)
  if (missionCtx && missionCtx.messages.length > 0) {
    // Build multi-turn: previous exchanges + new user message
    messages = []
    for (const msg of missionCtx.messages) {
      messages.push({ role: 'user', content: 'Continue with the mission.' })
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
    // Store in mission context
    storeMissionResult(missionId, unit.id, result.result, result.result.slice(0, 500))
  } else {
    console.log(`  -> FAIL: ${result.error}`)
  }

  res.json(result)
})

// --- Streaming execute endpoint (Step 4) ---
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

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const systemPrompt = buildSystemPrompt(unit, task.context || '')

  let userMessage = task.description
  if (previousContext) {
    userMessage = `Previous findings from other agents:\n\n${previousContext}\n\n---\n\nYour task: ${task.description}`
  }

  // Build multi-turn messages from mission context
  let messages
  const missionCtx = getMissionContext(missionId, unit.id)
  if (missionCtx && missionCtx.messages.length > 0) {
    messages = []
    for (const msg of missionCtx.messages) {
      messages.push({ role: 'user', content: 'Continue with the mission.' })
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
        // Store in mission context
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

// --- LLM-Based Routing (Step 3) ---
app.post('/api/route', async (req, res) => {
  const { message } = req.body

  if (!message) {
    return res.status(400).json({
      success: false,
      error: 'Missing required field: message'
    })
  }

  // Use Haiku for fast, cheap routing decisions
  const routingPrompt = `You are a military task router. Given these generals and their specialties, assign the incoming task to the best one.

Generals:
- gen-research: Information gathering, analysis, documentation, literature review, data exploration, competitive analysis
- gen-planning: Strategy, architecture, system design, project planning, risk assessment, resource allocation
- gen-execution: Code implementation, deployment, testing, debugging, performance optimisation, building

Task: "${message}"

Respond with ONLY valid JSON (no markdown, no explanation):
{"generalId": "<id>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}`

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
        // Validate the generalId
        const validIds = ['gen-research', 'gen-planning', 'gen-execution']
        if (!validIds.includes(parsed.generalId)) {
          parsed.generalId = 'gen-research'
          parsed.reasoning = (parsed.reasoning || '') + ' (corrected: invalid generalId)'
        }
        res.json({
          generalId: parsed.generalId,
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

  // Keyword fallback if LLM fails
  const ROUTING_KEYWORDS = {
    'gen-research': ['search', 'find', 'gather', 'analyze', 'investigate', 'read', 'documentation', 'learn', 'explore', 'discover'],
    'gen-planning': ['plan', 'design', 'strategy', 'approach', 'architect', 'organize', 'structure', 'outline', 'prepare'],
    'gen-execution': ['implement', 'fix', 'build', 'write', 'deploy', 'test', 'run', 'execute', 'create', 'code', 'develop']
  }

  const lowerMessage = message.toLowerCase()
  let bestMatch = { generalId: 'gen-research', confidence: 0.3, reasoning: 'Default assignment' }

  for (const [generalId, keywords] of Object.entries(ROUTING_KEYWORDS)) {
    const matched = keywords.filter(kw => lowerMessage.includes(kw))
    const confidence = Math.min(matched.length / 3, 1.0)
    if (confidence > bestMatch.confidence) {
      bestMatch = {
        generalId,
        confidence: Math.round(confidence * 100) / 100,
        reasoning: `Keyword fallback — matched: ${matched.join(', ')}`
      }
    }
  }

  bestMatch.llmRouted = false
  res.json(bestMatch)
})

// --- Mission management (Step 5) ---
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
  console.log(`Command Centre API running on port ${PORT}`)
  console.log(`API key configured: ${!!process.env.ANTHROPIC_API_KEY}`)
})
