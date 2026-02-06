#!/usr/bin/env node

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync, mkdirSync } from 'node:fs'
import { config } from 'dotenv'
import { loadState, saveState, nextSessionId, mergeKnowledgeUpdates } from './state.js'
import { runSession } from './session-runner.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- Parse CLI args ---
const args = process.argv.slice(2)
const flags = {}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--state' && args[i + 1]) flags.state = args[++i]
  else if (args[i] === '--log' && args[i + 1]) flags.log = args[++i]
  else if (args[i] === '--session-type' && args[i + 1]) flags.sessionType = args[++i]
  else if (args[i] === '--dry-run') flags.dryRun = true
  else if (args[i] === '--verbose') flags.verbose = true
  else if (args[i] === '--help') { printHelp(); process.exit(0) }
}

function printHelp() {
  console.log(`AXIOM CLI — Autonomous research session runner

Usage: node axiom-cli.js [options]

Options:
  --state <path>       State file path (default: ./data/state.json)
  --log <path>         Log file path (default: ./data/axiom.log)
  --session-type <t>   auto | literature | status | experiment (default: auto)
  --dry-run            Load state and print plan without calling API
  --verbose            Print progress to stdout
  --help               Show this help`)
}

// --- Load environment ---
config({ path: resolve(__dirname, '.env') })

if (!process.env.ANTHROPIC_API_KEY && !flags.dryRun) {
  console.error('ERROR: ANTHROPIC_API_KEY not set. Create server/.env with your key.')
  process.exit(1)
}

// --- Resolve paths ---
const statePath = resolve(flags.state || resolve(__dirname, 'data', 'state.json'))
const logPath = resolve(flags.log || resolve(__dirname, 'data', 'axiom.log'))

mkdirSync(dirname(statePath), { recursive: true })
mkdirSync(dirname(logPath), { recursive: true })

// --- Log helper ---
function appendLog(entry) {
  const line = JSON.stringify(entry) + '\n'
  appendFileSync(logPath, line)
}

// --- Main ---
async function main() {
  const verbose = flags.verbose || false
  const dryRun = flags.dryRun || false
  const sessionType = flags.sessionType || 'auto'

  if (verbose) {
    console.log(`AXIOM CLI starting`)
    console.log(`  State: ${statePath}`)
    console.log(`  Log: ${logPath}`)
    console.log(`  Session type: ${sessionType}`)
    if (dryRun) console.log(`  Mode: DRY RUN`)
  }

  // Load state
  const state = loadState(statePath)
  if (verbose) console.log(`  Sessions so far: ${state.sessionCount}`)

  // Run session
  const { session, knowledgeUpdates, error } = await runSession(state, {
    sessionType,
    verbose,
    dryRun
  })

  if (error) {
    console.error(`Session failed: ${error}`)
    appendLog({ timestamp: new Date().toISOString(), event: 'error', error })
    process.exit(1)
  }

  // Assign session ID and merge into state
  session.id = nextSessionId(state)
  state.sessionCount++
  state.sessions.push(session)

  // Merge knowledge updates
  mergeKnowledgeUpdates(state, knowledgeUpdates)

  // Save state
  if (!dryRun) {
    saveState(statePath, state)
  }

  // Log summary
  const summary = {
    timestamp: session.timestamp,
    event: 'session_complete',
    sessionId: session.id,
    type: session.type,
    tokens: session.tokens,
    searchCount: session.searchCount,
    durationMs: session.durationMs,
    findingsCount: knowledgeUpdates?.keyFindings.length || 0,
    updatesCount: session.proposedUpdates.length,
    totalSessions: state.sessionCount
  }

  appendLog(summary)

  if (verbose) {
    console.log(`\n=== Session Summary ===`)
    console.log(`  ID: ${session.id}`)
    console.log(`  Type: ${session.type}`)
    console.log(`  Duration: ${(session.durationMs / 1000).toFixed(1)}s`)
    console.log(`  Tokens: ${session.tokens.input + session.tokens.output}`)
    console.log(`  Web searches: ${session.searchCount}`)
    console.log(`  Key findings: ${knowledgeUpdates?.keyFindings.length || 0}`)
    console.log(`  Proposed updates: ${session.proposedUpdates.length}`)
    console.log(`  Total sessions: ${state.sessionCount}`)
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message)
  appendLog({ timestamp: new Date().toISOString(), event: 'fatal', error: err.message })
  process.exit(1)
})
