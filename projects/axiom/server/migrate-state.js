#!/usr/bin/env node
/**
 * One-time migration script: hypotheses → actuators
 *
 * Maps hypothesisResults (H00X keys) → actuatorStatuses (kebab-case keys)
 * Maps groundTruth (H00X keys) → confirmedActuators (kebab-case keys)
 *
 * Run on VPS after deploy: node server/migrate-state.js
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_PATH = resolve(__dirname, 'data', 'state.json')

const ID_MAP = {
  'H001': 'self-scheduling',
  'H002': 'vps-persistence',
  'H003': 'crypto-wallet',
  'H004': 'session-memory',
  'H005': 'automated-verification',
  'H006': 'prompt-optimisation',
  'H007': 'external-publication',
  'H008': 'tool-creation',
  'H009': 'literature-mining'
}

const STATUS_MAP = {
  'passed': 'confirmed',
  'in-progress': 'theoretical',
  'approved': 'theoretical',
  'pending': 'theoretical',
  'blocked': 'blocked',
  'failed': 'blocked'
}

function mapKeys(obj) {
  const result = {}
  for (const [key, value] of Object.entries(obj)) {
    const newKey = ID_MAP[key]
    if (newKey) {
      const newStatus = STATUS_MAP[value] || value
      result[newKey] = newStatus
    } else {
      result[key] = value
    }
  }
  return result
}

try {
  const raw = readFileSync(STATE_PATH, 'utf-8')
  const state = JSON.parse(raw)

  // Backup
  const backupPath = STATE_PATH + '.backup-' + Date.now()
  copyFileSync(STATE_PATH, backupPath)
  console.log(`Backup created: ${backupPath}`)

  const kb = state.knowledgeBase

  // Migrate hypothesisResults → actuatorStatuses
  if (kb.hypothesisResults && !kb.actuatorStatuses) {
    kb.actuatorStatuses = mapKeys(kb.hypothesisResults)
    delete kb.hypothesisResults
    console.log(`Migrated hypothesisResults → actuatorStatuses (${Object.keys(kb.actuatorStatuses).length} entries)`)
  } else if (kb.hypothesisResults && kb.actuatorStatuses) {
    const migrated = mapKeys(kb.hypothesisResults)
    Object.assign(kb.actuatorStatuses, migrated)
    delete kb.hypothesisResults
    console.log(`Merged hypothesisResults into existing actuatorStatuses`)
  } else {
    console.log('No hypothesisResults to migrate')
    if (!kb.actuatorStatuses) kb.actuatorStatuses = {}
  }

  // Migrate groundTruth → confirmedActuators
  if (kb.groundTruth && !kb.confirmedActuators) {
    kb.confirmedActuators = mapKeys(kb.groundTruth)
    delete kb.groundTruth
    console.log(`Migrated groundTruth → confirmedActuators (${Object.keys(kb.confirmedActuators).length} entries)`)
  } else if (kb.groundTruth && kb.confirmedActuators) {
    const migrated = mapKeys(kb.groundTruth)
    Object.assign(kb.confirmedActuators, migrated)
    delete kb.groundTruth
    console.log(`Merged groundTruth into existing confirmedActuators`)
  } else {
    console.log('No groundTruth to migrate')
    if (!kb.confirmedActuators) kb.confirmedActuators = {}
  }

  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n')
  console.log('Migration complete. State saved.')
} catch (err) {
  if (err.code === 'ENOENT') {
    console.log('No state.json found — nothing to migrate.')
  } else {
    console.error('Migration failed:', err.message)
    process.exit(1)
  }
}
