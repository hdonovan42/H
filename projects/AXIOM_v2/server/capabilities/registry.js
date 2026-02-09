// Value-based capability registry for AXIOM v2
import { readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let modules = []

export async function loadCapabilities() {
  modules = []
  const files = readdirSync(__dirname).filter(
    f => f.endsWith('.js') && f !== 'registry.js'
  )

  for (const file of files) {
    try {
      const mod = await import(resolve(__dirname, file) + '?t=' + Date.now())
      const cap = mod.default
      if (!cap || !cap.id || !cap.tools || !cap.execute) {
        console.log(`  [Registry] Skipping ${file}: missing required interface (need id, tools, execute)`)
        continue
      }
      modules.push(cap)
    } catch (err) {
      console.log(`  [Registry] Failed to load ${file}: ${err.message}`)
    }
  }

  console.log(`  [Registry] Loaded ${modules.length} capability modules: ${modules.map(m => m.id).join(', ')}`)
  return modules
}

export function getAllTools() {
  return modules.flatMap(mod => mod.tools)
}

export function getAllToolDescriptions() {
  return modules.map(mod =>
    mod.tools.map(t => `- ${t.name}: ${t.description} (${mod.id})`).join('\n')
  ).flat()
}

export async function executeAnyToolCall(name, input) {
  for (const mod of modules) {
    const tool = mod.tools.find(t => t.name === name)
    if (tool) {
      return await mod.execute(name, input)
    }
  }
  return `Error: tool "${name}" not found in any capability module`
}

export async function verifyAll() {
  const results = {}
  for (const mod of modules) {
    try {
      const result = await mod.verify()
      results[mod.id] = {
        operational: result.operational,
        lastVerified: new Date().toISOString(),
        evidence: result.evidence
      }
    } catch (err) {
      results[mod.id] = {
        operational: false,
        lastVerified: new Date().toISOString(),
        evidence: `Verification error: ${err.message}`
      }
    }
  }
  return results
}

export function getAllModules() {
  return modules
}
