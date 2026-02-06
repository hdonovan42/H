#!/usr/bin/env node

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { loadState, saveState } from './state.js'
import { loadCapabilities, initRegistry, verifyAll, getAllModules } from './capabilities/registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- Parse CLI args ---
const args = process.argv.slice(2)
const flags = {}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--state' && args[i + 1]) flags.state = args[++i]
  else if (args[i] === '--verbose') flags.verbose = true
  else if (args[i] === '--dry-run') flags.dryRun = true
  else if (args[i] === '--help') { printHelp(); process.exit(0) }
}

function printHelp() {
  console.log(`AXIOM Capability Verifier

Usage: node verify-capabilities.js [options]

Options:
  --state <path>    State file path (default: ./data/state.json)
  --verbose         Print detailed verification output
  --dry-run         Verify without updating state
  --help            Show this help`)
}

// --- Load environment ---
config({ path: resolve(__dirname, '.env') })

const statePath = resolve(flags.state || resolve(__dirname, 'data', 'state.json'))
const verbose = flags.verbose || false

async function main() {
  console.log('AXIOM Capability Verification')
  console.log('=============================\n')

  // Load state
  const state = loadState(statePath)
  console.log(`State: ${state.sessionCount} sessions, ${state.knowledgeBase?.keyFindings?.length || 0} findings`)

  // Load and initialise registry
  await loadCapabilities()
  initRegistry(state)

  const modules = getAllModules()
  console.log(`Modules loaded: ${modules.length}\n`)

  // Run verification on ALL modules (not just active ones)
  const results = await verifyAll()

  const confirmed = state.knowledgeBase?.confirmedActuators || {}
  const statuses = state.knowledgeBase?.actuatorStatuses || {}

  let passCount = 0
  let failCount = 0
  let readyForConfirmation = []
  let failedWhileConfirmed = []

  for (const [actuatorId, result] of Object.entries(results)) {
    const isConfirmed = confirmed[actuatorId] === 'confirmed' || statuses[actuatorId] === 'confirmed'
    const icon = result.operational ? '\u2713' : '\u2717'

    if (result.operational) passCount++
    else failCount++

    console.log(`  ${icon} ${actuatorId}: ${result.operational ? 'OPERATIONAL' : 'NOT OPERATIONAL'}`)
    if (verbose) {
      console.log(`    Evidence: ${result.evidence}`)
      console.log(`    Confirmed: ${isConfirmed ? 'yes' : 'no'}`)
    }

    // Track notable states
    if (result.operational && !isConfirmed) {
      readyForConfirmation.push(actuatorId)
    }
    if (!result.operational && isConfirmed) {
      failedWhileConfirmed.push(actuatorId)
    }
  }

  console.log(`\nResults: ${passCount} operational, ${failCount} not operational`)

  if (readyForConfirmation.length > 0) {
    console.log(`\n  READY FOR CONFIRMATION (passing verification but not confirmed):`)
    for (const id of readyForConfirmation) {
      console.log(`    -> ${id}`)
    }
  }

  if (failedWhileConfirmed.length > 0) {
    console.log(`\n  WARNING (confirmed but failing verification):`)
    for (const id of failedWhileConfirmed) {
      console.log(`    !! ${id} — ${results[id].evidence}`)
    }
  }

  // Update state with verification results
  if (!flags.dryRun) {
    if (!state.knowledgeBase.operationalCapabilities) {
      state.knowledgeBase.operationalCapabilities = {}
    }

    for (const [actuatorId, result] of Object.entries(results)) {
      const existing = state.knowledgeBase.operationalCapabilities[actuatorId]
      state.knowledgeBase.operationalCapabilities[actuatorId] = {
        operational: result.operational,
        lastVerified: result.lastVerified,
        evidence: result.evidence,
        usageCount: existing?.usageCount || 0
      }
    }

    saveState(statePath, state)
    console.log(`\nState updated: ${statePath}`)
  } else {
    console.log(`\n[DRY RUN] State not updated`)
  }
}

main().catch(err => {
  console.error('Verification failed:', err.message)
  process.exit(1)
})
