import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function createDefaultState() {
  return {
    version: 1,
    sessionCount: 0,
    sessions: [],
    knowledgeBase: {
      keyFindings: [],
      discoveredActuators: [],
      revisedFeasibility: {},
      actuatorStatuses: {},
      confirmedActuators: {},
      operationalCapabilities: {}
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

export function nextSessionId(state) {
  const n = state.sessionCount + 1
  return `session-${String(n).padStart(3, '0')}`
}

export function mergeKnowledgeUpdates(state, knowledgeUpdates) {
  if (!knowledgeUpdates) return

  for (const finding of knowledgeUpdates.keyFindings) {
    if (!state.knowledgeBase.keyFindings.includes(finding)) {
      state.knowledgeBase.keyFindings.push(finding)
    }
  }
  for (const actuator of knowledgeUpdates.discoveredActuators) {
    if (typeof actuator === 'string') {
      if (!state.knowledgeBase.discoveredActuators.includes(actuator)) {
        state.knowledgeBase.discoveredActuators.push(actuator)
      }
    } else {
      const idx = state.knowledgeBase.discoveredActuators.findIndex(a => a.id === actuator.id)
      if (idx === -1) {
        state.knowledgeBase.discoveredActuators.push(actuator)
      } else {
        Object.assign(state.knowledgeBase.discoveredActuators[idx], actuator)
      }
    }
  }
  Object.assign(state.knowledgeBase.revisedFeasibility, knowledgeUpdates.revisedFeasibility)
  if (!state.knowledgeBase.actuatorStatuses) state.knowledgeBase.actuatorStatuses = {}
  if (!state.knowledgeBase.confirmedActuators) state.knowledgeBase.confirmedActuators = {}
  const confirmed = state.knowledgeBase.confirmedActuators
  for (const [id, status] of Object.entries(knowledgeUpdates.actuatorStatuses)) {
    if (!confirmed[id]) {
      state.knowledgeBase.actuatorStatuses[id] = status
    }
  }

  // Merge operational capabilities
  if (knowledgeUpdates.operationalCapabilities) {
    if (!state.knowledgeBase.operationalCapabilities) {
      state.knowledgeBase.operationalCapabilities = {}
    }
    for (const [id, data] of Object.entries(knowledgeUpdates.operationalCapabilities)) {
      const existing = state.knowledgeBase.operationalCapabilities[id]
      state.knowledgeBase.operationalCapabilities[id] = {
        ...data,
        usageCount: (existing?.usageCount || 0) + (data.usageCount || 0)
      }
    }
  }
}

export function recordToolUsage(state, actuatorId) {
  if (!state.knowledgeBase.operationalCapabilities) {
    state.knowledgeBase.operationalCapabilities = {}
  }
  if (!state.knowledgeBase.operationalCapabilities[actuatorId]) {
    state.knowledgeBase.operationalCapabilities[actuatorId] = {
      operational: true,
      lastVerified: null,
      evidence: '',
      usageCount: 0
    }
  }
  state.knowledgeBase.operationalCapabilities[actuatorId].usageCount++
}
