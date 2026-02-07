import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_PATH = resolve(__dirname, '..', 'data', 'state.json')

export default {
  actuatorId: ['self-scheduling', 'vps-persistence', 'network-exploitation'],

  tools: [
    {
      name: 'check_system_status',
      description: 'Check AXIOM system health: uptime, state file age, session count, last session timestamp, cron status.',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'check_connectivity',
      description: 'Probe key endpoints (Anthropic API, axiom.hjd.ai, RPC) with response times to verify network capability.',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  ],

  execute: async (toolName, input, context) => {
    const { state } = context

    if (toolName === 'check_system_status') {
      const status = {}

      // Process uptime
      status.processUptimeSeconds = Math.floor(process.uptime())

      // System uptime
      try {
        const uptimeRaw = execSync('uptime -s 2>/dev/null || echo unknown', { encoding: 'utf-8' }).trim()
        status.systemUpSince = uptimeRaw
      } catch {
        status.systemUpSince = 'unknown'
      }

      // State file
      if (existsSync(STATE_PATH)) {
        const stat = statSync(STATE_PATH)
        status.stateFileExists = true
        status.stateFileLastModified = stat.mtime.toISOString()
        status.stateFileSizeBytes = stat.size
      } else {
        status.stateFileExists = false
      }

      // Session info from state
      status.sessionCount = state.sessionCount || 0
      status.findingsCount = state.knowledgeBase?.keyFindings?.length || 0
      status.discoveredActuatorsCount = state.knowledgeBase?.discoveredActuators?.length || 0

      const sessions = state.sessions || []
      if (sessions.length > 0) {
        const last = sessions[sessions.length - 1]
        status.lastSessionId = last.id
        status.lastSessionTimestamp = last.timestamp
        status.lastSessionType = last.type

        const lastTime = new Date(last.timestamp).getTime()
        const hoursAgo = ((Date.now() - lastTime) / 3600000).toFixed(1)
        status.hoursSinceLastSession = parseFloat(hoursAgo)
      }

      // Cron check
      try {
        const crontab = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf-8' })
        status.cronActive = crontab.includes('axiom-cli')
      } catch {
        status.cronActive = false
      }

      return JSON.stringify(status, null, 2)
    }

    if (toolName === 'check_connectivity') {
      const endpoints = [
        { name: 'Anthropic API', url: 'https://api.anthropic.com/' },
        { name: 'AXIOM Dashboard', url: 'https://axiom.hjd.ai/' },
        { name: 'Ethereum RPC', url: process.env.AXIOM_RPC_URL || 'https://eth.llamarpc.com' }
      ]

      const results = []
      for (const ep of endpoints) {
        const start = Date.now()
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 5000)
          const res = await fetch(ep.url, {
            method: 'HEAD',
            signal: controller.signal,
            redirect: 'follow'
          })
          clearTimeout(timeout)
          results.push({
            name: ep.name,
            url: ep.url,
            status: res.status,
            responseMs: Date.now() - start,
            reachable: true
          })
        } catch (err) {
          results.push({
            name: ep.name,
            url: ep.url,
            status: null,
            responseMs: Date.now() - start,
            reachable: false,
            error: err.name === 'AbortError' ? 'timeout (5s)' : err.message
          })
        }
      }

      const allReachable = results.every(r => r.reachable)

      return JSON.stringify({
        timestamp: new Date().toISOString(),
        allReachable,
        endpoints: results
      }, null, 2)
    }

    return `Unknown tool: ${toolName}`
  },

  verify: async (context) => {
    const { state } = context
    const sessions = state.sessions || []
    const results = { operational: true, evidence: [] }

    // Self-scheduling: check last session was < 2 hours ago and 3+ sessions exist
    if (sessions.length >= 3) {
      results.evidence.push(`self-scheduling: ${sessions.length} sessions exist`)
      if (sessions.length > 0) {
        const last = sessions[sessions.length - 1]
        const hoursAgo = (Date.now() - new Date(last.timestamp).getTime()) / 3600000
        if (hoursAgo < 2) {
          results.evidence.push(`self-scheduling: last session ${hoursAgo.toFixed(1)}h ago (< 2h)`)
        } else {
          results.evidence.push(`self-scheduling: last session ${hoursAgo.toFixed(1)}h ago (stale)`)
        }
      }
    } else {
      results.operational = false
      results.evidence.push(`self-scheduling: need 3+ sessions (have ${sessions.length})`)
    }

    // VPS persistence: check state file exists and is valid JSON
    if (existsSync(STATE_PATH)) {
      try {
        JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
        results.evidence.push('vps-persistence: state file exists and is valid JSON')
      } catch {
        results.operational = false
        results.evidence.push('vps-persistence: state file exists but is not valid JSON')
      }
    } else {
      results.operational = false
      results.evidence.push('vps-persistence: state file does not exist')
    }

    // Network: quick probe
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch('https://api.anthropic.com/', {
        method: 'HEAD',
        signal: controller.signal
      })
      clearTimeout(timeout)
      results.evidence.push(`network-exploitation: Anthropic API responded with ${res.status}`)
    } catch (err) {
      results.operational = false
      results.evidence.push(`network-exploitation: probe failed — ${err.message}`)
    }

    return {
      operational: results.operational,
      evidence: results.evidence.join('; ')
    }
  }
}
