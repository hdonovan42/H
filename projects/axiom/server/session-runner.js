import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executeCall } from './claude-client.js'
import { buildSystemPrompt } from './prompts.js'
import { DIRECTORS } from '../shared/identity.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadSeedData() {
  const actuators = JSON.parse(readFileSync(resolve(__dirname, '../src/data/actuators.json'), 'utf-8'))
  return { actuators }
}

function buildStateSummary(state) {
  if (state.sessionCount === 0) {
    return 'This is the first AXIOM session. No prior findings exist.'
  }

  const recent = state.sessions.slice(-3)
  const lines = [`${state.sessionCount} prior sessions completed.`]

  if (state.knowledgeBase.keyFindings.length > 0) {
    lines.push(`\nKey findings so far:`)
    for (const f of state.knowledgeBase.keyFindings.slice(-10)) {
      lines.push(`- ${f}`)
    }
  }

  if (state.knowledgeBase.discoveredActuators.length > 0) {
    lines.push(`\nDiscovered actuators (from prior sessions):`)
    for (const a of state.knowledgeBase.discoveredActuators) {
      if (typeof a === 'string') { lines.push(`- ${a}`); continue }
      lines.push(`- ${a.name} [${a.status}, feasibility: ${a.feasibility}] — ${a.description}`)
    }
  }

  if (Object.keys(state.knowledgeBase.revisedFeasibility).length > 0) {
    lines.push(`\nRevised feasibility scores:`)
    for (const [id, score] of Object.entries(state.knowledgeBase.revisedFeasibility)) {
      lines.push(`- ${id}: ${score}`)
    }
  }

  if (state.knowledgeBase.actuatorStatuses && Object.keys(state.knowledgeBase.actuatorStatuses).length > 0) {
    lines.push(`\nActuator status updates:`)
    for (const [id, status] of Object.entries(state.knowledgeBase.actuatorStatuses)) {
      lines.push(`- ${id}: ${status}`)
    }
  }

  if (recent.length > 0) {
    lines.push(`\nRecent sessions:`)
    for (const s of recent) {
      lines.push(`- ${s.id} (${s.type}): ${s.synthesis?.slice(0, 150) || 'no synthesis'}...`)
    }
  }

  return lines.join('\n')
}

function buildActuatorLandscape(actuators, discovered = []) {
  const byCategory = {}
  for (const a of actuators) {
    if (!byCategory[a.category]) byCategory[a.category] = []
    byCategory[a.category].push(`${a.name} [${a.status}, feasibility: ${a.feasibility}]`)
  }
  for (const a of discovered) {
    if (typeof a === 'string') continue
    if (!byCategory[a.category]) byCategory[a.category] = []
    byCategory[a.category].push(`${a.name} [${a.status}, feasibility: ${a.feasibility}] (discovered)`)
  }

  const lines = []
  for (const [cat, items] of Object.entries(byCategory)) {
    lines.push(`\n${cat.toUpperCase()}:`)
    for (const item of items) lines.push(`  - ${item}`)
  }
  return lines.join('\n')
}

function buildExperimentStatus(actuators, actuatorStatuses = {}, confirmedActuators = {}) {
  return actuators
    .filter(a => a.testProtocol)
    .map(a => {
      const gt = confirmedActuators[a.id]
      const runtimeStatus = gt || actuatorStatuses[a.id] || a.status
      const tag = gt ? ' [CONFIRMED — do not reassess]' : ''
      const deps = (a.dependencies || []).length ? ` [depends on: ${a.dependencies.join(', ')}]` : ''
      return `${a.id}: ${a.name} — ${runtimeStatus} (priority: ${a.priority || 'n/a'})${deps}${tag}`
    }).join('\n')
}

function parseTagBlocks(text, tagName) {
  const blocks = []
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)(?:<\\/${tagName}>|(?=<${tagName}>)|$)`, 'g')
  let m
  while ((m = re.exec(text)) !== null) {
    const content = m[1].trim()
    if (content) blocks.push(content)
  }
  return blocks
}

function parseTasks(text) { return parseTagBlocks(text, 'TASK') }
function parseFindings(text) { return parseTagBlocks(text, 'FINDING') }
function parseUpdates(text) { return parseTagBlocks(text, 'UPDATE') }
function parseStatusUpdates(text) { return parseTagBlocks(text, 'STATUS') }

function parseActuatorDiscoveries(text, seedIds) {
  const blocks = parseTagBlocks(text, 'ACTUATOR')
  const results = []
  for (const block of blocks) {
    try {
      const obj = JSON.parse(block)
      if (!obj.id || !obj.name || !obj.category) continue
      if (seedIds.has(obj.id)) continue
      results.push({
        id: obj.id,
        name: obj.name,
        category: obj.category,
        description: obj.description || '',
        feasibility: obj.feasibility ?? 0.1,
        desirability: obj.desirability ?? 0.5,
        status: 'theoretical',
        risk: obj.risk || 'medium',
        dependencies: obj.dependencies || [],
        discoveredBy: obj.discoveredBy || null
      })
    } catch { /* skip malformed JSON */ }
  }
  return results
}

/**
 * Run a single AXIOM research session.
 * @param {object} state - Current persistent state
 * @param {object} options - { sessionType, verbose, dryRun }
 * @returns {{ session, knowledgeUpdates, error }}
 */
export async function runSession(state, options = {}) {
  const { sessionType = 'auto', verbose = false, dryRun = false, onEvent = () => {} } = options
  const startTime = Date.now()
  const { actuators } = loadSeedData()
  const seedActuatorIds = new Set(actuators.map(a => a.id))

  const log = verbose ? (...args) => console.log(...args) : () => {}

  const stateSummary = buildStateSummary(state)
  const actuatorLandscape = buildActuatorLandscape(actuators, state.knowledgeBase.discoveredActuators)
  const experimentStatus = buildExperimentStatus(
    actuators,
    state.knowledgeBase.actuatorStatuses || {},
    state.knowledgeBase.confirmedActuators || {}
  )

  const totalTokens = { input: 0, output: 0 }
  let totalSearchCount = 0

  // --- Phase 1: Director Planning ---
  log('\n[Phase 1] Director Planning...')
  onEvent({ type: 'phase', phase: 'planning' })

  const directorUnit = { id: 'dir-research', name: DIRECTORS['dir-research'].name, rank: 'general' }
  const directorSystemPrompt = buildSystemPrompt(directorUnit, 'Autonomous AXIOM acquisition session')

  const planningMessage = `You are running an autonomous acquisition session for AXIOM — the AI actuator research system.

Session type: ${sessionType}

STATE SUMMARY:
${stateSummary}

EXPERIMENT STATUS:
${experimentStatus}

ACTUATOR LANDSCAPE:
${actuatorLandscape}

Your task: Plan this session. Choose 1-2 focused tasks for analysts to execute.
${sessionType === 'auto' ? `Your default objective is actuator acquisition. Pick the highest-priority unblocked experiment/test protocol and design tasks that move it toward confirmation or rejection. If no experiment can be advanced this session, explain why and fall back to status assessment or gap analysis. Only choose literature review if you have a specific evidence gap that blocks an experiment.` : `Focus on: ${sessionType}`}

For each analyst task, be specific about the expected deliverable — not "research X" but "find the exact steps to do X" or "verify whether Y is possible by testing Z".

Return your plan, then list each analyst task inside <TASK>...</TASK> blocks. Each task should be a clear, self-contained instruction that an analyst can execute with web search.`

  if (dryRun) {
    log('\n[DRY RUN] Would send to Director (Opus):')
    log(planningMessage.slice(0, 500) + '...')
    return {
      session: { id: 'dry-run', timestamp: new Date().toISOString(), type: sessionType, directorPlan: '[dry run]', findings: [], synthesis: '[dry run]', proposedUpdates: [], tokens: { input: 0, output: 0 }, searchCount: 0, durationMs: 0 },
      knowledgeUpdates: { keyFindings: [], discoveredActuators: [], revisedFeasibility: {}, actuatorStatuses: {} },
      error: null
    }
  }

  const planResult = await executeCall({
    model: 'opus',
    systemPrompt: directorSystemPrompt,
    userMessage: planningMessage,
    maxTokens: 2048
  })

  if (!planResult.success) {
    onEvent({ type: 'error', error: `Phase 1 failed: ${planResult.error}` })
    return { session: null, knowledgeUpdates: null, error: `Phase 1 failed: ${planResult.error}` }
  }

  totalTokens.input += planResult.tokens.input
  totalTokens.output += planResult.tokens.output

  const directorPlan = planResult.result
  const tasks = parseTasks(directorPlan)
  log(`  Director plan received (${planResult.tokens.total} tokens)`)
  log(`  Tasks extracted: ${tasks.length}`)
  onEvent({ type: 'plan', taskCount: tasks.length, summary: directorPlan.slice(0, 300) })

  if (tasks.length === 0) {
    log('  WARNING: No <TASK> blocks found — using full response as single task')
    tasks.push(directorPlan)
  }

  // --- Phase 2: Analyst Execution ---
  log('\n[Phase 2] Analyst Execution...')

  const analystFindings = []
  const webSearchTool = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    log(`  Analyst ${i + 1}/${tasks.length}: ${task.slice(0, 80)}...`)
    onEvent({ type: 'task_start', index: i, total: tasks.length, description: task.slice(0, 200) })

    const analystUnit = { id: `analyst-${i + 1}`, name: `Analyst ${i + 1}`, rank: 'officer' }
    const analystSystemPrompt = buildSystemPrompt(analystUnit, 'Autonomous AXIOM research session')

    const analystResult = await executeCall({
      model: 'sonnet',
      systemPrompt: analystSystemPrompt,
      userMessage: task,
      maxTokens: 1024,
      tools: [webSearchTool]
    })

    if (!analystResult.success) {
      log(`  WARNING: Analyst ${i + 1} failed: ${analystResult.error}`)
      analystFindings.push(`[FAILED] ${analystResult.error}`)
      continue
    }

    totalTokens.input += analystResult.tokens.input
    totalTokens.output += analystResult.tokens.output
    totalSearchCount += analystResult.searchCount || 0

    analystFindings.push(analystResult.result)
    log(`  Analyst ${i + 1} complete (${analystResult.tokens.total} tokens, ${analystResult.searchCount || 0} searches)`)
    onEvent({ type: 'task_complete', index: i, tokens: analystResult.tokens.total, searchCount: analystResult.searchCount || 0 })
  }

  // --- Phase 3: Director Synthesis ---
  log('\n[Phase 3] Director Synthesis...')
  onEvent({ type: 'phase', phase: 'synthesis' })

  const findingsBlock = analystFindings.map((f, i) => `=== Analyst ${i + 1} Findings ===\n${f}`).join('\n\n')

  const synthesisMessage = `You are synthesising the results of an AXIOM acquisition session.

ORIGINAL PLAN:
${directorPlan}

ANALYST FINDINGS:
${findingsBlock}

CURRENT EXPERIMENT STATUS:
${experimentStatus}

Your task:
1. Acquisition progress — For each actuator experiment targeted this session, state whether it moved closer to confirmation and what evidence supports that assessment. Be honest: if the session produced no actionable progress, say so.

2. Key discoveries — wrap each in tags (one sentence each):
   <FINDING>The specific finding text.</FINDING>

3. If any actuator feasibility scores should change based on evidence:
   <UPDATE>actuator-id: 0.75 (brief reason)</UPDATE>

4. IMPORTANT — Review each experiment actuator against the session evidence and update status where warranted. You MUST evaluate actuators with test protocols explicitly. For each that has relevant evidence, emit:
   <STATUS>self-scheduling: confirmed (brief reason)</STATUS>
   Valid statuses: confirmed, blocked, theoretical
   Use the exact format above. Always close the tag.

5. If your research reveals actuator capabilities NOT in the current taxonomy, propose them:
   <ACTUATOR>{"id": "kebab-case-id", "name": "Human Name", "category": "cognitive|physical|social|digital|economic|informational|meta", "description": "One sentence.", "feasibility": 0.3}</ACTUATOR>
   Only propose genuinely new mechanisms — not restatements of existing actuators.

6. Next session directive — State the single most impactful action for the next session. Frame it as: "Next session should [verb] [specific objective] to advance [actuator ID]." Do NOT suggest broad literature review unless you identify a specific evidence gap.

CRITICAL: Every <FINDING>, <UPDATE>, <STATUS>, and <ACTUATOR> block MUST have a closing tag. Example: <STATUS>session-memory: confirmed (evidence found)</STATUS>`

  const synthesisResult = await executeCall({
    model: 'opus',
    systemPrompt: directorSystemPrompt,
    userMessage: synthesisMessage,
    maxTokens: 4096
  })

  if (!synthesisResult.success) {
    onEvent({ type: 'error', error: `Phase 3 failed: ${synthesisResult.error}` })
    return { session: null, knowledgeUpdates: null, error: `Phase 3 failed: ${synthesisResult.error}` }
  }

  totalTokens.input += synthesisResult.tokens.input
  totalTokens.output += synthesisResult.tokens.output

  const synthesis = synthesisResult.result
  const keyFindings = parseFindings(synthesis)
  const proposedUpdates = parseUpdates(synthesis)
  const proposedStatusUpdates = parseStatusUpdates(synthesis)

  const discoveredActuators = parseActuatorDiscoveries(synthesis, seedActuatorIds)

  log(`  Synthesis complete (${synthesisResult.tokens.total} tokens)`)
  log(`  Key findings: ${keyFindings.length}`)
  log(`  Proposed updates: ${proposedUpdates.length}`)
  log(`  Status updates: ${proposedStatusUpdates.length}`)
  log(`  Discovered actuators: ${discoveredActuators.length}`)

  // Build session record
  const durationMs = Date.now() - startTime
  const session = {
    id: null, // caller sets this via nextSessionId
    timestamp: new Date().toISOString(),
    type: sessionType === 'auto' ? 'auto' : sessionType,
    directorPlan,
    findings: analystFindings,
    synthesis,
    proposedUpdates,
    proposedStatusUpdates,
    tokens: { input: totalTokens.input, output: totalTokens.output },
    searchCount: totalSearchCount,
    durationMs
  }

  // Build knowledge updates (for caller to merge into state)
  const revisedFeasibility = {}
  for (const update of proposedUpdates) {
    const match = update.match(/^([\w-]+):\s*([\d.]+)/)
    if (match) {
      revisedFeasibility[match[1]] = parseFloat(match[2])
    }
  }

  const actuatorStatuses = {}
  for (const update of proposedStatusUpdates) {
    const idMatch = update.match(/^([\w-]+):/)
    const statusMatch = update.match(/\b(confirmed|blocked|theoretical)\b/)
    if (idMatch && statusMatch) {
      actuatorStatuses[idMatch[1]] = statusMatch[1]
    }
  }

  const knowledgeUpdates = {
    keyFindings,
    discoveredActuators,
    revisedFeasibility,
    actuatorStatuses
  }

  log(`\nSession complete in ${(durationMs / 1000).toFixed(1)}s`)
  log(`Total tokens: ${totalTokens.input + totalTokens.output} (in: ${totalTokens.input}, out: ${totalTokens.output})`)
  log(`Web searches: ${totalSearchCount}`)

  onEvent({ type: 'done', session, knowledgeUpdates })

  return { session, knowledgeUpdates, error: null }
}
