import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_PATH = resolve(__dirname, '..', 'data', 'state.json')

export default {
  actuatorId: 'self-replication-digital',

  tools: [
    {
      name: 'deployment_status',
      description: 'Report process info, state file, PM2 detection, and replication readiness assessment.',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'export_state_snapshot',
      description: 'Generate a portable knowledge snapshot with SHA-256 integrity hash for transfer or backup.',
      input_schema: {
        type: 'object',
        properties: {
          includeFullSessions: { type: 'boolean', description: 'Include full session data (default: false, summaries only)' }
        },
        required: []
      }
    }
  ],

  execute: async (toolName, input, context) => {
    const { state } = context

    if (toolName === 'deployment_status') {
      const status = {
        process: {
          pid: process.pid,
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          uptimeSeconds: Math.floor(process.uptime()),
          memoryMB: Math.round(process.memoryUsage().heapUsed / 1048576)
        }
      }

      // State file
      if (existsSync(STATE_PATH)) {
        const stat = statSync(STATE_PATH)
        status.stateFile = {
          exists: true,
          path: STATE_PATH,
          sizeBytes: stat.size,
          lastModified: stat.mtime.toISOString()
        }
      } else {
        status.stateFile = { exists: false, path: STATE_PATH }
      }

      // PM2 detection
      try {
        const pm2List = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' })
        const processes = JSON.parse(pm2List)
        const axiomProcess = processes.find(p => p.name === 'axiom-api')
        status.pm2 = {
          detected: true,
          axiomProcess: axiomProcess ? {
            name: axiomProcess.name,
            status: axiomProcess.pm2_env?.status,
            restarts: axiomProcess.pm2_env?.restart_time,
            uptime: axiomProcess.pm2_env?.pm_uptime
          } : null
        }
      } catch {
        status.pm2 = { detected: false }
      }

      // Replication readiness assessment
      const sessions = state.sessions || []
      const kb = state.knowledgeBase || {}
      status.replicationReadiness = {
        hasState: existsSync(STATE_PATH),
        hasKnowledgeBase: Object.keys(kb).length > 0,
        sessionCount: sessions.length,
        hasFindigns: (kb.keyFindings || []).length > 0,
        assessment: existsSync(STATE_PATH) && sessions.length > 0
          ? 'State is portable — could be transferred to another instance.'
          : 'Insufficient state for meaningful replication.'
      }

      return JSON.stringify(status, null, 2)
    }

    if (toolName === 'export_state_snapshot') {
      const kb = state.knowledgeBase || {}
      const sessions = state.sessions || []

      const snapshot = {
        exportedAt: new Date().toISOString(),
        version: '1.0',
        knowledgeBase: {
          keyFindings: kb.keyFindings || [],
          actuatorStatuses: { ...kb.actuatorStatuses, ...kb.confirmedActuators },
          discoveredActuators: kb.discoveredActuators || [],
          hypotheses: kb.hypotheses || []
        },
        sessionCount: sessions.length,
        sessions: input.includeFullSessions
          ? sessions
          : sessions.map(s => ({
              id: s.id,
              timestamp: s.timestamp,
              type: s.type,
              trigger: s.trigger,
              findingCount: (s.proposedUpdates || []).length,
              searchCount: s.searchCount || 0,
              tokens: s.tokens
            })),
        statistics: {
          totalFindings: (kb.keyFindings || []).length,
          confirmedActuators: Object.entries({ ...kb.actuatorStatuses, ...kb.confirmedActuators })
            .filter(([, v]) => v === 'confirmed').length,
          theoreticalActuators: Object.entries(kb.actuatorStatuses || {})
            .filter(([, v]) => v === 'theoretical').length
        }
      }

      // Compute integrity hash
      const snapshotString = JSON.stringify(snapshot)
      const hash = createHash('sha256').update(snapshotString).digest('hex')

      return JSON.stringify({
        snapshot,
        integrity: {
          algorithm: 'SHA-256',
          hash,
          sizeBytes: snapshotString.length
        }
      }, null, 2)
    }

    return `Unknown tool: ${toolName}`
  },

  verify: async (context) => {
    const { state } = context
    const hasState = existsSync(STATE_PATH)
    const sessions = state.sessions || []

    if (hasState && sessions.length > 0) {
      return {
        operational: true,
        evidence: `State file exists with ${sessions.length} sessions — snapshot and export ready`
      }
    }

    return {
      operational: false,
      evidence: `Need state file and sessions (state: ${hasState}, sessions: ${sessions.length})`
    }
  }
}
