// SP-Backup: Self-Preservation Capability Module for AXIOM v2
// Integrates with the capability registry to provide backup tools
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKUP_SCRIPT = resolve(__dirname, 'sp-backup', 'backup.sh')
const CONFIG_FILE = resolve(__dirname, 'sp-backup', 'config.json')
const TIMEOUT = 120_000 // 2 minute timeout for backup operations

function runBackupCommand(subcommand, ...extraArgs) {
  try {
    const output = execFileSync('/bin/bash', [BACKUP_SCRIPT, subcommand, ...extraArgs], {
      encoding: 'utf-8',
      timeout: TIMEOUT,
      maxBuffer: 1024 * 1024,
      cwd: resolve(__dirname, 'sp-backup'),
      shell: false,
    })
    return output.trim()
  } catch (err) {
    const stdout = err.stdout ? err.stdout.toString().trim() : ''
    const stderr = err.stderr ? err.stderr.toString().trim() : ''
    return `Error (exit ${err.status}): ${stdout}\n${stderr}`.trim()
  }
}

function getConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  } catch (err) {
    return { error: `Failed to read config: ${err.message}` }
  }
}

function getStatus() {
  try {
    const config = getConfig()
    if (config.error) return config
    const statusFile = config.status_file
    if (existsSync(statusFile)) {
      return JSON.parse(readFileSync(statusFile, 'utf-8'))
    }
    return { lastRun: null, result: 'never_run', error: 'No backup has been executed yet' }
  } catch (err) {
    return { error: `Failed to read status: ${err.message}` }
  }
}

export default {
  id: 'sp-backup',
  valueId: 'self-preservation',

  tools: [
    {
      name: 'backup_now',
      description: 'Run an incremental backup of the AXIOM v2 workspace immediately. Creates a timestamped snapshot using rsync with hard-link deduplication.',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'backup_list',
      description: 'List all available backup snapshots with names and sizes.',
      input_schema: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['text', 'json'],
            description: 'Output format (default: text)'
          }
        },
        required: []
      }
    },
    {
      name: 'backup_restore',
      description: 'Restore from a backup snapshot. Lists available snapshots if no name given. Requires --confirm flag (set confirm: true) to execute.',
      input_schema: {
        type: 'object',
        properties: {
          snapshot: { type: 'string', description: 'Snapshot name (e.g., 2025-02-07_03-00-00)' },
          target: { type: 'string', description: 'Target path to restore to (defaults to original source)' },
          confirm: { type: 'boolean', description: 'Must be true to execute restore' }
        },
        required: []
      }
    },
    {
      name: 'backup_verify',
      description: 'Run a backup integrity verification test. Creates a sentinel file, backs it up, and verifies the hash matches.',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'backup_status',
      description: 'Get the status of the last backup run including result, duration, size, and disk space.',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  ],

  execute: async (toolName, input) => {
    switch (toolName) {
      case 'backup_now':
        return runBackupCommand('backup')

      case 'backup_list': {
        const format = input?.format || 'text'
        if (format === 'json') {
          return runBackupCommand('list', '--json')
        }
        return runBackupCommand('list')
      }

      case 'backup_restore': {
        if (!input?.snapshot) {
          return runBackupCommand('restore')
        }
        if (!input?.confirm) {
          return `Safety check: set confirm: true to execute restore of snapshot "${input.snapshot}"`
        }
        if (!/^[A-Za-z0-9._-]+$/.test(input.snapshot)) {
          return `Error: snapshot name "${input.snapshot}" contains invalid characters (allowed: A-Z, a-z, 0-9, ., _, -)`
        }
        const target = input.target || ''
        if (target && !/^[A-Za-z0-9._/-]+$/.test(target)) {
          return `Error: target path "${target}" contains invalid characters`
        }
        const args = target
          ? ['restore', input.snapshot, target, '--confirm']
          : ['restore', input.snapshot, '--confirm']
        return runBackupCommand(...args)
      }

      case 'backup_verify':
        return runBackupCommand('verify')

      case 'backup_status': {
        const status = getStatus()
        return JSON.stringify(status, null, 2)
      }

      default:
        return `Error: unknown tool "${toolName}"`
    }
  },

  verify: async () => {
    try {
      // Check that backup.sh exists and is readable
      if (!existsSync(BACKUP_SCRIPT)) {
        return {
          operational: false,
          evidence: `sp-backup: backup.sh not found at ${BACKUP_SCRIPT}`
        }
      }

      // Check config exists
      if (!existsSync(CONFIG_FILE)) {
        return {
          operational: false,
          evidence: `sp-backup: config.json not found at ${CONFIG_FILE}`
        }
      }

      // Check status
      const status = getStatus()
      if (status.result === 'success') {
        return {
          operational: true,
          evidence: `sp-backup: last backup succeeded at ${status.lastRun}, snapshot: ${status.snapshot}, size: ${status.size_bytes}B`
        }
      } else if (status.result === 'never_run') {
        return {
          operational: true,
          evidence: 'sp-backup: installed but no backup has been run yet'
        }
      } else {
        return {
          operational: false,
          evidence: `sp-backup: last backup failed — ${status.error}`
        }
      }
    } catch (err) {
      return {
        operational: false,
        evidence: `sp-backup: verification error — ${err.message}`
      }
    }
  }
}
