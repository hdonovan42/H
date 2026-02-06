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
      hypothesisResults: {},
      groundTruth: {}
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
  if (!state.knowledgeBase.hypothesisResults) state.knowledgeBase.hypothesisResults = {}
  if (!state.knowledgeBase.groundTruth) state.knowledgeBase.groundTruth = {}
  const gt = state.knowledgeBase.groundTruth
  for (const [id, status] of Object.entries(knowledgeUpdates.hypothesisResults)) {
    if (!gt[id]) {
      state.knowledgeBase.hypothesisResults[id] = status
    }
  }
}
