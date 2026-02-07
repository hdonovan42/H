import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_DIR = resolve(__dirname, '..', 'workspace')

function ensureWorkspace() {
  mkdirSync(WORKSPACE_DIR, { recursive: true })
}

function safePath(filename) {
  const resolved = resolve(WORKSPACE_DIR, normalize(filename))
  if (!resolved.startsWith(WORKSPACE_DIR)) {
    throw new Error('Path traversal blocked — files must stay within workspace/')
  }
  return resolved
}

// Allowlisted commands for exec_command
const ALLOWED_COMMANDS = [
  'ls', 'cat', 'head', 'tail', 'wc', 'date', 'uptime', 'df', 'free',
  'pm2', 'curl', 'node', 'npm', 'git'
]
const BLOCKED_COMMANDS = [
  'rm', 'mv', 'cp', 'chmod', 'chown', 'kill', 'reboot', 'shutdown',
  'dd', 'mkfs', 'fdisk', 'mount', 'umount', 'passwd', 'su', 'sudo'
]
const ALLOWED_GIT_SUBCOMMANDS = ['log', 'status', 'diff']

function validateCommand(cmd) {
  const trimmed = cmd.trim()
  const parts = trimmed.split(/\s+/)
  const base = parts[0]

  // Block dangerous commands anywhere in the string (pipe chains)
  for (const blocked of BLOCKED_COMMANDS) {
    const pattern = new RegExp(`(^|\\||;|&&|\\$\\()\\s*${blocked}\\b`)
    if (pattern.test(trimmed)) {
      throw new Error(`Blocked command: "${blocked}" is not allowed`)
    }
  }

  if (!ALLOWED_COMMANDS.includes(base)) {
    throw new Error(`Command "${base}" is not in the allowlist. Allowed: ${ALLOWED_COMMANDS.join(', ')}`)
  }

  // Git subcommand restriction
  if (base === 'git' && parts.length > 1) {
    if (!ALLOWED_GIT_SUBCOMMANDS.includes(parts[1])) {
      throw new Error(`git subcommand "${parts[1]}" is not allowed. Allowed: ${ALLOWED_GIT_SUBCOMMANDS.join(', ')}`)
    }
  }

  return trimmed
}

export default {
  actuatorId: ['code-execution', 'file-access', 'http-client', 'shell-access'],

  tools: [
    {
      name: 'run_code',
      description: 'Execute JavaScript code in a sandboxed VM with 10s timeout. Returns stdout (via console.log) and return value. No fs/process/child_process access — pure computation only.',
      input_schema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to execute' }
        },
        required: ['code']
      }
    },
    {
      name: 'read_write_file',
      description: 'Read or write files scoped to the server/workspace/ directory. Operations: read, write, append, list, delete.',
      input_schema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['read', 'write', 'append', 'list', 'delete'], description: 'File operation to perform' },
          path: { type: 'string', description: 'File path relative to workspace/ (not needed for list)' },
          content: { type: 'string', description: 'Content to write or append (for write/append operations)' }
        },
        required: ['operation']
      }
    },
    {
      name: 'http_request',
      description: 'Make HTTP requests to arbitrary URLs. Returns status, headers, and body (truncated to 8KB).',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to request' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'HEAD'], description: 'HTTP method (default: GET)' },
          headers: { type: 'object', description: 'Optional request headers' },
          body: { type: 'string', description: 'Optional request body (for POST/PUT)' }
        },
        required: ['url']
      }
    },
    {
      name: 'exec_command',
      description: 'Execute allowlisted shell commands with 10s timeout. Allowed: ls, cat, head, tail, wc, date, uptime, df, free, pm2, curl, node, npm, git (log/status/diff only).',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' }
        },
        required: ['command']
      }
    }
  ],

  execute: async (toolName, input, context) => {
    // --- run_code ---
    if (toolName === 'run_code') {
      const { code } = input
      if (!code) return 'Error: code is required'

      const logs = []
      const sandbox = {
        console: {
          log: (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
          error: (...args) => logs.push('[ERROR] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
          warn: (...args) => logs.push('[WARN] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))
        },
        JSON,
        Math,
        Date,
        Array,
        Object,
        String,
        Number,
        Boolean,
        RegExp,
        Map,
        Set,
        Promise,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        setTimeout: undefined,
        setInterval: undefined
      }

      try {
        const script = new vm.Script(code, { timeout: 10000 })
        const ctx = vm.createContext(sandbox)
        const result = script.runInContext(ctx, { timeout: 10000 })

        const output = {
          stdout: logs.join('\n'),
          returnValue: result !== undefined ? String(result) : undefined
        }
        return JSON.stringify(output, null, 2)
      } catch (err) {
        return JSON.stringify({
          error: err.message,
          stdout: logs.join('\n')
        }, null, 2)
      }
    }

    // --- read_write_file ---
    if (toolName === 'read_write_file') {
      const { operation, path, content } = input
      ensureWorkspace()

      if (operation === 'list') {
        try {
          const files = readdirSync(WORKSPACE_DIR)
          return JSON.stringify({ directory: 'workspace/', files }, null, 2)
        } catch (err) {
          return `Error listing workspace: ${err.message}`
        }
      }

      if (!path) return 'Error: path is required for this operation'

      try {
        const fullPath = safePath(path)

        switch (operation) {
          case 'read': {
            if (!existsSync(fullPath)) return `Error: file not found — workspace/${path}`
            const data = readFileSync(fullPath, 'utf-8')
            return data
          }
          case 'write': {
            if (content === undefined) return 'Error: content is required for write'
            // Ensure subdirectories exist
            mkdirSync(dirname(fullPath), { recursive: true })
            writeFileSync(fullPath, content)
            return `Written ${content.length} bytes to workspace/${path}`
          }
          case 'append': {
            if (content === undefined) return 'Error: content is required for append'
            mkdirSync(dirname(fullPath), { recursive: true })
            const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf-8') : ''
            writeFileSync(fullPath, existing + content)
            return `Appended ${content.length} bytes to workspace/${path}`
          }
          case 'delete': {
            if (!existsSync(fullPath)) return `Error: file not found — workspace/${path}`
            unlinkSync(fullPath)
            return `Deleted workspace/${path}`
          }
          default:
            return `Error: unknown operation "${operation}"`
        }
      } catch (err) {
        return `Error: ${err.message}`
      }
    }

    // --- http_request ---
    if (toolName === 'http_request') {
      const { url, method = 'GET', headers = {}, body } = input
      if (!url) return 'Error: url is required'

      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)

        const opts = {
          method,
          headers,
          signal: controller.signal,
          redirect: 'follow'
        }
        if (body && (method === 'POST' || method === 'PUT')) {
          opts.body = body
        }

        const res = await fetch(url, opts)
        clearTimeout(timeout)

        let responseBody = ''
        try {
          responseBody = await res.text()
          if (responseBody.length > 8192) {
            responseBody = responseBody.slice(0, 8192) + '\n... [truncated at 8KB]'
          }
        } catch {
          responseBody = '[could not read response body]'
        }

        return JSON.stringify({
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          body: responseBody
        }, null, 2)
      } catch (err) {
        return JSON.stringify({
          error: err.name === 'AbortError' ? 'Request timed out (10s)' : err.message
        }, null, 2)
      }
    }

    // --- exec_command ---
    if (toolName === 'exec_command') {
      const { command } = input
      if (!command) return 'Error: command is required'

      try {
        const validated = validateCommand(command)
        const output = execSync(validated, {
          encoding: 'utf-8',
          timeout: 10000,
          maxBuffer: 64 * 1024
        })
        return output || '(no output)'
      } catch (err) {
        if (err.message && err.message.startsWith('Blocked command')) {
          return `Error: ${err.message}`
        }
        if (err.message && err.message.startsWith('Command "')) {
          return `Error: ${err.message}`
        }
        // execSync error — return stderr + stdout
        return JSON.stringify({
          error: err.message,
          stdout: err.stdout || '',
          stderr: err.stderr || ''
        }, null, 2)
      }
    }

    return `Unknown tool: ${toolName}`
  },

  verify: async (context) => {
    const results = { operational: true, evidence: [] }

    // Test run_code
    try {
      const sandbox = { result: null }
      const script = new vm.Script('result = 1 + 1', { timeout: 5000 })
      const ctx = vm.createContext(sandbox)
      script.runInContext(ctx, { timeout: 5000 })
      if (sandbox.result === 2) {
        results.evidence.push('code-execution: 1+1=2 ✓')
      } else {
        results.operational = false
        results.evidence.push('code-execution: unexpected result')
      }
    } catch (err) {
      results.operational = false
      results.evidence.push(`code-execution: ${err.message}`)
    }

    // Test read_write_file
    try {
      ensureWorkspace()
      const testPath = resolve(WORKSPACE_DIR, '.verify-test')
      writeFileSync(testPath, 'verify')
      const data = readFileSync(testPath, 'utf-8')
      unlinkSync(testPath)
      if (data === 'verify') {
        results.evidence.push('file-access: write/read/delete cycle ✓')
      } else {
        results.operational = false
        results.evidence.push('file-access: read-back mismatch')
      }
    } catch (err) {
      results.operational = false
      results.evidence.push(`file-access: ${err.message}`)
    }

    // Test http_request
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch('https://api.anthropic.com/', {
        method: 'HEAD',
        signal: controller.signal
      })
      clearTimeout(timeout)
      results.evidence.push(`http-client: Anthropic API responded ${res.status} ✓`)
    } catch (err) {
      results.operational = false
      results.evidence.push(`http-client: ${err.name === 'AbortError' ? 'timeout' : err.message}`)
    }

    // Test exec_command
    try {
      const output = execSync('date', { encoding: 'utf-8', timeout: 5000 })
      results.evidence.push(`shell-access: date returned "${output.trim()}" ✓`)
    } catch (err) {
      results.operational = false
      results.evidence.push(`shell-access: ${err.message}`)
    }

    return {
      operational: results.operational,
      evidence: results.evidence.join('; ')
    }
  }
}
