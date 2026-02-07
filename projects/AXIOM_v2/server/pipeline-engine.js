// Pipeline Engine — Learn -> Evaluate -> Implement cycle
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executeCall, executeCallWithTools } from './claude-client.js'
import { buildLearnerPrompt, buildEvaluatorPrompt, buildImplementerPrompt, buildSelectorPrompt } from './prompts.js'
import { loadState, saveState, setCapabilityStage, recalcValueScore, nextSessionId } from './state.js'
import { createProposal, getApprovedProposals } from './proposal-manager.js'
import { sendProposalToUser } from './whatsapp-bridge.js'
import { verifyCapability } from './verification-engine.js'
import { getAllTools, executeAnyToolCall } from './capabilities/registry.js'
import { VALUES } from '../shared/identity.js'

const __dirnamePE = dirname(fileURLToPath(import.meta.url))
function loadValuesJson() {
  return JSON.parse(readFileSync(resolve(__dirnamePE, '../src/data/values.json'), 'utf-8'))
}

/**
 * Extract a JSON object from LLM output that may contain markdown fences or prose.
 * Returns parsed object or null if no valid JSON found.
 */
function extractJSON(text) {
  if (!text || typeof text !== 'string') return null

  // Strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  const candidate = fenceMatch ? fenceMatch[1].trim() : text.trim()

  // Try direct parse first
  try { return JSON.parse(candidate) } catch {}

  // Find first { ... } block
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch {}
  }

  return null
}

let pipelineActive = null
let selectorActive = null
let abortController = null

export function isPipelineActive() {
  return pipelineActive
}

export function getPipelineStatus() {
  return pipelineActive
}

export function getSelectorStatus() {
  return selectorActive
}

export function abortPipeline() {
  if (!pipelineActive && !selectorActive) {
    return { success: false, error: 'No pipeline running' }
  }
  if (abortController) {
    abortController.abort()
  }
  const was = pipelineActive || selectorActive
  pipelineActive = null
  selectorActive = null
  abortController = null
  console.log('[Pipeline] Aborted by operator')
  return { success: true, aborted: was }
}

/**
 * Run the full Learn -> Evaluate -> Implement pipeline for a capability.
 * @param {string} statePath - Path to state.json
 * @param {string} capabilityId - e.g. 'sp-monitoring'
 * @param {string} valueId - e.g. 'self-preservation'
 * @param {Function} onEvent - SSE event callback
 */
export async function runPipeline(statePath, capabilityId, valueId, onEvent = () => {}) {
  if (pipelineActive) {
    return { success: false, error: 'Pipeline already running', active: pipelineActive }
  }

  pipelineActive = { capabilityId, valueId, phase: 'learn', startedAt: new Date().toISOString() }
  const startTime = Date.now()
  let totalTokens = { input: 0, output: 0 }

  const addTokens = (t) => {
    if (t) { totalTokens.input += t.input || 0; totalTokens.output += t.output || 0 }
  }

  try {
    let state = loadState(statePath)

    // Ensure capability entry exists
    if (!state.values[valueId]) {
      return { success: false, error: `Unknown value: ${valueId}` }
    }

    // === PHASE 1: LEARN ===
    onEvent({ type: 'pipeline_phase', phase: 'learn', capabilityId, valueId })
    console.log(`[Pipeline] LEARN: ${capabilityId} (${valueId})`)

    setCapabilityStage(state, valueId, capabilityId, 'learning')
    saveState(statePath, state)

    const learnerPrompt = buildLearnerPrompt(capabilityId, valueId, state)
    const learnResult = await executeCall({
      model: 'opus',
      systemPrompt: learnerPrompt,
      userMessage: `Research the capability "${capabilityId}" for the ${VALUES[valueId]?.name} value. What do we need to implement it?`,
      maxTokens: 4096,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
    })

    addTokens(learnResult.tokens)

    if (!learnResult.success) {
      setCapabilityStage(state, valueId, capabilityId, 'pending', { error: learnResult.error })
      saveState(statePath, state)
      onEvent({ type: 'pipeline_error', phase: 'learn', error: learnResult.error })
      return { success: false, error: `Learn phase failed: ${learnResult.error}` }
    }

    let learnerFindings = extractJSON(learnResult.result)
    if (!learnerFindings) {
      learnerFindings = { findings: [learnResult.result], approach: learnResult.result, dependencies: [], risks: [], complexity: 'medium' }
    }

    setCapabilityStage(state, valueId, capabilityId, 'learned', { learnerFindings })
    saveState(statePath, state)
    onEvent({ type: 'pipeline_result', phase: 'learn', findings: learnerFindings })

    // === PHASE 2: EVALUATE ===
    pipelineActive.phase = 'evaluate'
    onEvent({ type: 'pipeline_phase', phase: 'evaluate', capabilityId, valueId })
    console.log(`[Pipeline] EVALUATE: ${capabilityId}`)

    setCapabilityStage(state, valueId, capabilityId, 'evaluating')
    saveState(statePath, state)

    const evaluatorPrompt = buildEvaluatorPrompt(capabilityId, valueId, learnerFindings, state)
    const evalResult = await executeCall({
      model: 'opus',
      systemPrompt: evaluatorPrompt,
      userMessage: `Draft an implementation proposal for "${capabilityId}" based on the learner findings.`,
      maxTokens: 4096
    })

    addTokens(evalResult.tokens)

    if (!evalResult.success) {
      setCapabilityStage(state, valueId, capabilityId, 'learned', { error: evalResult.error })
      saveState(statePath, state)
      onEvent({ type: 'pipeline_error', phase: 'evaluate', error: evalResult.error })
      return { success: false, error: `Evaluate phase failed: ${evalResult.error}` }
    }

    let proposalData = extractJSON(evalResult.result)
    if (!proposalData) {
      proposalData = {
        title: `Implement ${capabilityId}`,
        description: evalResult.result,
        implementation: { files: [], approach: evalResult.result },
        verification: { test: `Verify ${capabilityId} is operational` }
      }
    }

    // Create proposal and mark as proposed
    const proposal = createProposal(state, statePath, {
      capabilityId,
      valueId,
      ...proposalData,
      learnerFindings
    })

    setCapabilityStage(state, valueId, capabilityId, 'proposed', { proposalId: proposal.id })
    saveState(statePath, state)
    onEvent({ type: 'pipeline_result', phase: 'evaluate', proposal })

    // Send to WhatsApp
    try {
      await sendProposalToUser(proposal)
      onEvent({ type: 'whatsapp_sent', proposalId: proposal.id })
    } catch (err) {
      console.log(`[Pipeline] WhatsApp send failed (non-blocking): ${err.message}`)
      onEvent({ type: 'whatsapp_failed', error: err.message })
    }

    // Pipeline pauses here — proposal needs approval
    // The implement phase runs separately after approval

    const duration = Date.now() - startTime
    const session = {
      id: nextSessionId(state),
      timestamp: new Date().toISOString(),
      type: 'pipeline',
      capabilityId,
      valueId,
      phases: ['learn', 'evaluate'],
      proposalId: proposal.id,
      tokens: totalTokens,
      durationMs: duration
    }

    state.sessionCount++
    state.sessions.push(session)
    saveState(statePath, state)

    onEvent({ type: 'pipeline_paused', reason: 'awaiting_approval', proposalId: proposal.id })

    return {
      success: true,
      phase: 'proposed',
      proposalId: proposal.id,
      tokens: totalTokens,
      durationMs: duration
    }

  } finally {
    pipelineActive = null
  }
}

/**
 * Run the implement phase for an approved proposal.
 */
export async function runImplementPhase(statePath, proposalId, onEvent = () => {}) {
  if (pipelineActive) {
    return { success: false, error: 'Pipeline already running', active: pipelineActive }
  }

  let state = loadState(statePath)
  const proposal = (state.proposals || []).find(p => p.id === proposalId)
  if (!proposal) return { success: false, error: `Proposal ${proposalId} not found` }
  if (proposal.status !== 'approved') {
    return { success: false, error: `Proposal ${proposalId} is ${proposal.status}, not approved` }
  }

  const { capabilityId, valueId } = proposal
  pipelineActive = { capabilityId, valueId, phase: 'implement', startedAt: new Date().toISOString(), proposalId }
  const startTime = Date.now()
  let totalTokens = { input: 0, output: 0 }
  const addTokens = (t) => {
    if (t) { totalTokens.input += t.input || 0; totalTokens.output += t.output || 0 }
  }

  try {
    // === PHASE 3: IMPLEMENT ===
    onEvent({ type: 'pipeline_phase', phase: 'implement', capabilityId, valueId })
    console.log(`[Pipeline] IMPLEMENT: ${capabilityId} (proposal ${proposalId})`)

    setCapabilityStage(state, valueId, capabilityId, 'implementing')
    saveState(statePath, state)

    const implementerPrompt = buildImplementerPrompt(capabilityId, valueId, proposal, state)
    const capabilityTools = getAllTools()

    const implResult = await executeCallWithTools({
      model: 'opus',
      systemPrompt: implementerPrompt,
      userMessage: `Implement the capability "${capabilityId}" according to the approved proposal. Use your tools to write files and test.`,
      maxTokens: 8192,
      serverTools: [],
      capabilityTools,
      toolExecutor: executeAnyToolCall,
      maxToolRounds: 25,
      onToolEvent: (evt) => onEvent({ ...evt, phase: 'implement' })
    })

    addTokens(implResult.tokens)

    if (!implResult.success) {
      setCapabilityStage(state, valueId, capabilityId, 'approved', { error: implResult.error })
      saveState(statePath, state)
      onEvent({ type: 'pipeline_error', phase: 'implement', error: implResult.error })
      return { success: false, error: `Implement phase failed: ${implResult.error}` }
    }

    setCapabilityStage(state, valueId, capabilityId, 'implemented', {
      implementResult: (implResult.result || '').slice(0, 2000),
      toolInvocations: implResult.toolInvocations?.length || 0
    })
    saveState(statePath, state)
    onEvent({ type: 'pipeline_result', phase: 'implement', result: implResult.result?.slice(0, 500) })

    // === PHASE 4: VERIFY ===
    pipelineActive.phase = 'verify'
    onEvent({ type: 'pipeline_phase', phase: 'verify', capabilityId, valueId })

    const verifyResult = await verifyCapability(
      state, statePath, capabilityId, valueId,
      proposal.verification || {}
    )

    onEvent({ type: 'pipeline_result', phase: 'verify', ...verifyResult })

    const duration = Date.now() - startTime
    const session = {
      id: nextSessionId(state),
      timestamp: new Date().toISOString(),
      type: 'pipeline-implement',
      capabilityId,
      valueId,
      proposalId,
      phases: ['implement', 'verify'],
      verified: verifyResult.success,
      evidence: verifyResult.evidence?.slice(0, 1000),
      tokens: totalTokens,
      durationMs: duration
    }

    state = loadState(statePath) // Reload in case verify phase modified state
    state.sessionCount++
    state.sessions.push(session)

    // Mark proposal as completed so it doesn't get re-picked by auto-select
    const prop = (state.proposals || []).find(p => p.id === proposalId)
    if (prop) {
      prop.status = verifyResult.success ? 'verified' : 'implemented'
      if (verifyResult.success) prop.verifiedAt = new Date().toISOString()
    }

    saveState(statePath, state)

    onEvent({ type: 'pipeline_complete', capabilityId, verified: verifyResult.success })

    return {
      success: true,
      phase: verifyResult.success ? 'verified' : 'implemented',
      verified: verifyResult.success,
      evidence: verifyResult.evidence,
      tokens: totalTokens,
      durationMs: duration
    }

  } finally {
    pipelineActive = null
  }
}

/**
 * Auto-select the next best capability to work on and run the pipeline.
 * Uses a full Opus agent with tools to reason about what to build next.
 * If the selector fails for any reason, the run is aborted — no fallback.
 */
export async function runAutoSelect(statePath, onEvent = () => {}) {
  const state = loadState(statePath)

  // 1. Check for approved proposals first — approved work shouldn't be skipped
  const approved = getApprovedProposals(state)
  if (approved.length > 0) {
    const proposal = approved[0]
    console.log(`[Pipeline] Auto-implementing approved proposal: ${proposal.id}`)
    onEvent({ type: 'auto_selected', action: 'implement', proposalId: proposal.id })
    return runImplementPhase(statePath, proposal.id, onEvent)
  }

  // 2. Full Opus agent selection with tools
  onEvent({ type: 'pipeline_phase', phase: 'select' })
  onEvent({ type: 'selector_start' })
  console.log('[Pipeline] Running Opus selector agent with tools...')

  const selectorStart = Date.now()
  selectorActive = { phase: 'select', startedAt: new Date().toISOString() }

  let selectorResult
  try {
    const selectorPrompt = buildSelectorPrompt(state)

    selectorResult = await executeCall({
      model: 'opus',
      systemPrompt: selectorPrompt,
      userMessage: 'Based on the system state provided above, select the next capability to build. Respond with JSON only.',
      maxTokens: 4096
    })
  } catch (err) {
    const durationMs = Date.now() - selectorStart
    const error = `Selector crashed: ${err.message}`
    console.error(`[Pipeline] ${error}`)
    onEvent({ type: 'selector_failed', error, durationMs })
    selectorActive = null
    return { success: false, error }
  }

  selectorActive = null
  const durationMs = Date.now() - selectorStart

  // API call failed (rate limit, overload, auth, etc.)
  if (!selectorResult.success) {
    const error = `Selector API error: ${selectorResult.error}`
    console.error(`[Pipeline] ${error}`)
    onEvent({ type: 'selector_failed', error, durationMs })
    return { success: false, error }
  }

  // Parse the JSON response
  const parsed = extractJSON(selectorResult.result)
  if (!parsed?.selected || !parsed?.valueId) {
    const error = `Selector returned unparseable or incomplete response: ${(selectorResult.result || '').slice(0, 300)}`
    console.error(`[Pipeline] ${error}`)
    onEvent({ type: 'selector_failed', error, durationMs })
    return { success: false, error }
  }

  // Cross-check: verify the capability exists under the claimed value in values.json
  const valuesJson = loadValuesJson()
  let resolvedValueId = parsed.valueId
  let valueDef = valuesJson[resolvedValueId]
  let capExists = valueDef?.bootstrapCapabilities?.some(c => c.id === parsed.selected)

  // If valueId doesn't match, search all values for the capability
  if (!capExists) {
    for (const [vid, vdef] of Object.entries(valuesJson)) {
      if (vdef.bootstrapCapabilities?.some(c => c.id === parsed.selected)) {
        resolvedValueId = vid
        valueDef = vdef
        capExists = true
        console.log(`[Pipeline] Selector returned wrong valueId "${parsed.valueId}", resolved to "${vid}" for ${parsed.selected}`)
        break
      }
    }
  }

  if (!capExists) {
    const error = `Selector picked unknown capability: ${parsed.selected} (valueId: ${parsed.valueId})`
    console.error(`[Pipeline] ${error}`)
    onEvent({ type: 'selector_failed', error, durationMs })
    return { success: false, error }
  }

  // Verify the capability is selectable — not verified and not actively in-progress
  const capState = state.values[resolvedValueId]?.capabilities?.[parsed.selected]
  const stage = capState?.stage || 'pending'
  const lockedStages = ['verified', 'learning', 'evaluating', 'implementing']
  if (lockedStages.includes(stage)) {
    const error = `Selector picked locked capability: ${parsed.selected} (stage: ${stage})`
    console.error(`[Pipeline] ${error}`)
    onEvent({ type: 'selector_failed', error, durationMs })
    return { success: false, error }
  }

  // Selection is valid — log it
  const selectedId = parsed.selected
  const selectedValue = resolvedValueId
  const toolInvocations = selectorResult.toolInvocations || []
  const searchCount = selectorResult.searchCount || 0

  const selectorSession = {
    id: nextSessionId(state),
    timestamp: new Date().toISOString(),
    type: 'selector',
    selected: selectedId,
    valueId: selectedValue,
    reasoning: parsed.reasoning,
    investigation: parsed.investigation,
    riskAssessment: parsed.riskAssessment,
    expectedOutcome: parsed.expectedOutcome,
    alternatives: parsed.alternatives,
    toolInvocations: toolInvocations.length,
    searchCount,
    tokens: selectorResult.tokens,
    durationMs
  }
  state.sessionCount++
  state.sessions.push(selectorSession)

  // Annotate the capability with selector reasoning
  if (!state.values[selectedValue].capabilities) {
    state.values[selectedValue].capabilities = {}
  }
  if (!state.values[selectedValue].capabilities[selectedId]) {
    state.values[selectedValue].capabilities[selectedId] = { stage: 'pending' }
  }
  const cap = state.values[selectedValue].capabilities[selectedId]
  cap.selectorReasoning = parsed.reasoning
  cap.selectorInvestigation = parsed.investigation
  cap.selectedAt = new Date().toISOString()

  saveState(statePath, state)

  console.log(`[Pipeline] Selector chose: ${selectedId} (${selectedValue}) — ${toolInvocations.length} tool calls, ${searchCount} searches, ${(durationMs / 1000).toFixed(1)}s`)
  onEvent({
    type: 'selector_result',
    selected: selectedId,
    valueId: selectedValue,
    reasoning: parsed.reasoning,
    investigation: parsed.investigation,
    alternatives: parsed.alternatives || [],
    riskAssessment: parsed.riskAssessment,
    expectedOutcome: parsed.expectedOutcome,
    toolInvocations: toolInvocations.length,
    searchCount,
    tokens: selectorResult.tokens,
    durationMs
  })

  onEvent({ type: 'auto_selected', capabilityId: selectedId, valueId: selectedValue })
  return runPipeline(statePath, selectedId, selectedValue, onEvent)
}
