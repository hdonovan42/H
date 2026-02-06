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
      hypothesisResults: {}
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
