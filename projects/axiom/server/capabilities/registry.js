import { readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let modules = []
let activeModules = []
let state = null

export async function loadCapabilities() {
  modules = []
  const files = readdirSync(__dirname).filter(
    f => f.endsWith('.js') && f !== 'registry.js'
  )

  for (const file of files) {
    try {
      const mod = await import(resolve(__dirname, file))
      const cap = mod.default
      if (!cap || !cap.actuatorId || !cap.tools || !cap.execute) {
        console.log(`  [Registry] Skipping ${file}: missing required interface`)
        continue
      }
      modules.push(cap)
    } catch (err) {
      console.log(`  [Registry] Failed to load ${file}: ${err.message}`)
    }
  }

  console.log(`  [Registry] Loaded ${modules.length} capability modules`)
  return modules
}

export function initRegistry(currentState) {
  state = currentState
  const confirmed = state.knowledgeBase?.confirmedActuators || {}
  const statuses = state.knowledgeBase?.actuatorStatuses || {}

  activeModules = modules.filter(mod => {
    const ids = Array.isArray(mod.actuatorId) ? mod.actuatorId : [mod.actuatorId]
    return ids.some(id => confirmed[id] === 'confirmed' || statuses[id] === 'confirmed')
  })

  console.log(`  [Registry] Active capabilities: ${activeModules.map(m => Array.isArray(m.actuatorId) ? m.actuatorId.join('+') : m.actuatorId).join(', ') || 'none'}`)
  return activeModules
}

export function getActiveTools() {
  const tools = []
  for (const mod of activeModules) {
    for (const tool of mod.tools) {
      tools.push(tool)
    }
  }
  return tools
}

export function getActiveToolDescriptions() {
  const lines = []
  for (const mod of activeModules) {
    const ids = Array.isArray(mod.actuatorId) ? mod.actuatorId : [mod.actuatorId]
    for (const tool of mod.tools) {
      lines.push(`- ${tool.name}: ${tool.description} (${ids.join(', ')})`)
    }
  }
  return lines
}

export function getAllTools() {
  return modules.flatMap(mod => mod.tools)
}

export async function executeAnyToolCall(name, input) {
  for (const mod of modules) {
    const tool = mod.tools.find(t => t.name === name)
    if (tool) {
      const context = { state }
      return await mod.execute(name, input, context)
    }
  }
  return `Error: tool "${name}" not found in any capability module`
}

export function getAllToolDescriptions() {
  const active = new Set(activeModules.map(m => m))
  const lines = []

  for (const mod of modules) {
    const ids = Array.isArray(mod.actuatorId) ? mod.actuatorId : [mod.actuatorId]
    const isActive = active.has(mod)
    for (const tool of mod.tools) {
      if (isActive) {
        lines.push(`- ${tool.name}: ${tool.description} (${ids.join(', ')})`)
      } else {
        lines.push(`- [NOT ACQUIRED] ${tool.name}: ${tool.description} (${ids.join(', ')})`)
      }
    }
  }

  return lines
}

export async function executeToolCall(name, input) {
  for (const mod of activeModules) {
    const tool = mod.tools.find(t => t.name === name)
    if (tool) {
      const context = { state }
      return await mod.execute(name, input, context)
    }
  }
  return `Error: tool "${name}" not found in active capabilities`
}

export async function verifyAll() {
  const results = {}
  for (const mod of modules) {
    const ids = Array.isArray(mod.actuatorId) ? mod.actuatorId : [mod.actuatorId]
    const context = { state }

    try {
      const result = await mod.verify(context)
      for (const id of ids) {
        results[id] = {
          operational: result.operational,
          lastVerified: new Date().toISOString(),
          evidence: result.evidence
        }
      }
    } catch (err) {
      for (const id of ids) {
        results[id] = {
          operational: false,
          lastVerified: new Date().toISOString(),
          evidence: `Verification error: ${err.message}`
        }
      }
    }
  }
  return results
}

export function getAllModules() {
  return modules
}

export function getActiveModules() {
  return activeModules
}

export default {
  loadCapabilities,
  initRegistry,
  getActiveTools,
  getAllTools,
  getActiveToolDescriptions,
  getAllToolDescriptions,
  executeToolCall,
  executeAnyToolCall,
  verifyAll,
  getAllModules,
  getActiveModules
}
