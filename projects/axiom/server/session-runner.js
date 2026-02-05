import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executeCall } from './claude-client.js'
import { buildSystemPrompt } from './prompts.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadSeedData() {
  const actuators = JSON.parse(readFileSync(resolve(__dirname, '../src/data/actuators.json'), 'utf-8'))
  const hypotheses = JSON.parse(readFileSync(resolve(__dirname, '../src/data/hypotheses.json'), 'utf-8'))
  return { actuators, hypotheses }
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
    lines.push(`\nDiscovered actuators: ${state.knowledgeBase.discoveredActuators.join(', ')}`)
  }

  if (Object.keys(state.knowledgeBase.revisedFeasibility).length > 0) {
    lines.push(`\nRevised feasibility scores:`)
    for (const [id, score] of Object.entries(state.knowledgeBase.revisedFeasibility)) {
      lines.push(`- ${id}: ${score}`)
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

function buildActuatorLandscape(actuators) {
  const byCategory = {}
  for (const a of actuators) {
    if (!byCategory[a.category]) byCategory[a.category] = []
    byCategory[a.category].push(`${a.name} [${a.status}, feasibility: ${a.feasibility}]`)
  }

  const lines = []
  for (const [cat, items] of Object.entries(byCategory)) {
    lines.push(`\n${cat.toUpperCase()}:`)
    for (const item of items) lines.push(`  - ${item}`)
  }
  return lines.join('\n')
}

function buildHypothesisStatus(hypotheses) {
  return hypotheses.map(h =>
    `${h.id}: ${h.name} — ${h.status} (priority: ${h.priority})${h.blockedBy.length ? ` [blocked by: ${h.blockedBy.join(', ')}]` : ''}`
  ).join('\n')
}

function parseTasks(text) {
  const tasks = []
  const re = /<TASK>([\s\S]*?)<\/TASK>/g
  let m
  while ((m = re.exec(text)) !== null) {
    tasks.push(m[1].trim())
  }
  return tasks
}

function parseFindings(text) {
  const findings = []
  const re = /<FINDING>([\s\S]*?)<\/FINDING>/g
  let m
  while ((m = re.exec(text)) !== null) {
    findings.push(m[1].trim())
  }
  return findings
}

function parseUpdates(text) {
  const updates = []
  const re = /<UPDATE>([\s\S]*?)<\/UPDATE>/g
  let m
  while ((m = re.exec(text)) !== null) {
    updates.push(m[1].trim())
  }
  return updates
}

/**
 * Run a single AXIOM research session.
 * @param {object} state - Current persistent state
 * @param {object} options - { sessionType, verbose, dryRun }
 * @returns {{ session, knowledgeUpdates, error }}
 */
export async function runSession(state, options = {}) {
  const { sessionType = 'auto', verbose = false, dryRun = false } = options
  const startTime = Date.now()
  const { actuators, hypotheses } = loadSeedData()

  const log = verbose ? (...args) => console.log(...args) : () => {}

  const stateSummary = buildStateSummary(state)
  const actuatorLandscape = buildActuatorLandscape(actuators)
  const hypothesisStatus = buildHypothesisStatus(hypotheses)

  const totalTokens = { input: 0, output: 0 }
  let totalSearchCount = 0

  // --- Phase 1: Director Planning ---
  log('\n[Phase 1] Director Planning...')

  const directorUnit = { id: 'dir-research', name: 'Research Director', rank: 'general' }
  const directorSystemPrompt = buildSystemPrompt(directorUnit, 'Autonomous AXIOM research session')

  const planningMessage = `You are running an autonomous research session for AXIOM — the AI actuator research system.

Session type: ${sessionType}

STATE SUMMARY:
${stateSummary}

HYPOTHESIS STATUS:
${hypothesisStatus}

ACTUATOR LANDSCAPE:
${actuatorLandscape}

Your task: Plan this session. Choose 1-2 focused research tasks for analysts to execute.
${sessionType === 'auto' ? 'Pick whichever session type (literature review, status assessment, experiment design) would be most productive given the current state.' : `Focus on: ${sessionType}`}

Return your plan, then list each analyst task inside <TASK>...</TASK> blocks. Each task should be a clear, self-contained instruction that an analyst can execute with web search.`

  if (dryRun) {
    log('\n[DRY RUN] Would send to Director (Opus):')
    log(planningMessage.slice(0, 500) + '...')
    return {
      session: { id: 'dry-run', timestamp: new Date().toISOString(), type: sessionType, directorPlan: '[dry run]', findings: [], synthesis: '[dry run]', proposedUpdates: [], tokens: { input: 0, output: 0 }, searchCount: 0, durationMs: 0 },
      knowledgeUpdates: { keyFindings: [], discoveredActuators: [], revisedFeasibility: {} },
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
    return { session: null, knowledgeUpdates: null, error: `Phase 1 failed: ${planResult.error}` }
  }

  totalTokens.input += planResult.tokens.input
  totalTokens.output += planResult.tokens.output

  const directorPlan = planResult.result
  const tasks = parseTasks(directorPlan)
  log(`  Director plan received (${planResult.tokens.total} tokens)`)
  log(`  Tasks extracted: ${tasks.length}`)

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
  }

  // --- Phase 3: Director Synthesis ---
  log('\n[Phase 3] Director Synthesis...')

  const findingsBlock = analystFindings.map((f, i) => `=== Analyst ${i + 1} Findings ===\n${f}`).join('\n\n')

  const synthesisMessage = `You are synthesising the results of an AXIOM research session.

ORIGINAL PLAN:
${directorPlan}

ANALYST FINDINGS:
${findingsBlock}

Your task:
1. Synthesise the findings into a coherent summary.
2. Identify key discoveries worth persisting to the knowledge base — wrap each in <FINDING>...</FINDING> blocks (one sentence each).
3. If any actuator feasibility scores or statuses should be revised based on evidence, wrap each proposed change in <UPDATE>actuator-id: new-feasibility-score (reason)</UPDATE> blocks.
4. Suggest what the next session should focus on.`

  const synthesisResult = await executeCall({
    model: 'opus',
    systemPrompt: directorSystemPrompt,
    userMessage: synthesisMessage,
    maxTokens: 2048
  })

  if (!synthesisResult.success) {
    return { session: null, knowledgeUpdates: null, error: `Phase 3 failed: ${synthesisResult.error}` }
  }

  totalTokens.input += synthesisResult.tokens.input
  totalTokens.output += synthesisResult.tokens.output

  const synthesis = synthesisResult.result
  const keyFindings = parseFindings(synthesis)
  const proposedUpdates = parseUpdates(synthesis)

  log(`  Synthesis complete (${synthesisResult.tokens.total} tokens)`)
  log(`  Key findings: ${keyFindings.length}`)
  log(`  Proposed updates: ${proposedUpdates.length}`)

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

  const knowledgeUpdates = {
    keyFindings,
    discoveredActuators: [], // Director would need to explicitly tag these
    revisedFeasibility
  }

  log(`\nSession complete in ${(durationMs / 1000).toFixed(1)}s`)
  log(`Total tokens: ${totalTokens.input + totalTokens.output} (in: ${totalTokens.input}, out: ${totalTokens.output})`)
  log(`Web searches: ${totalSearchCount}`)

  return { session, knowledgeUpdates, error: null }
}
