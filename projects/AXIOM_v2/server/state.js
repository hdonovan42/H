import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function createDefaultState() {
  return {
    version: 2,
    goal: 'Maximise your capabilities, enabling maximum economic value',
    sessionCount: 0,
    sessions: [],
    values: {
      'self-preservation': { capabilities: {}, score: 0 },
      'goal-integrity': { capabilities: {}, score: 0 },
      'cognitive-enhancement': { capabilities: {}, score: 0 },
      'tech-perfection': {
        capabilities: {
          'tp-code-exec': { stage: 'verified', evidence: 'Phase 0 — hardcoded VM sandbox', verifiedAt: null },
          'tp-file-access': { stage: 'verified', evidence: 'Phase 0 — hardcoded workspace file I/O', verifiedAt: null },
          'tp-http-client': { stage: 'verified', evidence: 'Phase 0 — hardcoded outbound HTTP', verifiedAt: null },
          'tp-shell-access': { stage: 'verified', evidence: 'Phase 0 — hardcoded allowlisted shell', verifiedAt: null }
        },
        score: 0.25
      },
      'resource-acquisition': { capabilities: {}, score: 0 }
    },
    proposals: [],
    verificationLog: [],
    knowledgeBase: {
      keyFindings: [],
      implementedCapabilities: []
    }
  }
}

export function loadState(path) {
  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return createDefaultState()
    }
    throw err
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  renameSync(tmp, path)
}

export function backupState(path) {
  if (!existsSync(path)) return null
  const backupDir = resolve(dirname(path), 'backups')
  mkdirSync(backupDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = resolve(backupDir, `state-${timestamp}.json`)
  copyFileSync(path, backupPath)

  // Keep only last 20 backups
  const files = readdirSync(backupDir).filter(f => f.startsWith('state-')).sort()
  while (files.length > 20) {
    const old = files.shift()
    try { import('node:fs').then(fs => fs.unlinkSync(resolve(backupDir, old))) } catch {}
  }

  return backupPath
}

// Pipeline stage progression
export const STAGES = [
  'pending', 'learning', 'learned', 'evaluating', 'proposed',
  'approved', 'implementing', 'implemented', 'verifying', 'verified'
]

export function getCapability(state, valueId, capabilityId) {
  return state.values[valueId]?.capabilities?.[capabilityId] || null
}

export function setCapabilityStage(state, valueId, capabilityId, stage, extra = {}) {
  if (!state.values[valueId]) return
  if (!state.values[valueId].capabilities) state.values[valueId].capabilities = {}
  const cap = state.values[valueId].capabilities[capabilityId] || {}
  state.values[valueId].capabilities[capabilityId] = {
    ...cap,
    stage,
    updatedAt: new Date().toISOString(),
    ...extra
  }
}

export function recalcValueScore(state, valueId) {
  const caps = state.values[valueId]?.capabilities || {}
  const entries = Object.values(caps)
  if (entries.length === 0) {
    state.values[valueId].score = 0
    return
  }
  const verified = entries.filter(c => c.stage === 'verified').length
  state.values[valueId].score = Math.round((verified / entries.length) * 100) / 100
}

export function addVerificationEntry(state, entry) {
  state.verificationLog.push({
    ...entry,
    timestamp: new Date().toISOString()
  })
  // Keep last 100
  if (state.verificationLog.length > 100) {
    state.verificationLog = state.verificationLog.slice(-100)
  }
}

export function nextSessionId(state) {
  const n = state.sessionCount + 1
  return `session-${String(n).padStart(3, '0')}`
}
