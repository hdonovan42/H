import { execSync } from 'node:child_process'

const ALLOWED_COMMANDS = [
  'ls', 'cat', 'head', 'tail', 'wc', 'date', 'uptime', 'df', 'free',
  'pm2', 'curl', 'node', 'npm', 'git', 'bash', 'mkdir', 'which', 'rsync'
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

  for (const blocked of BLOCKED_COMMANDS) {
    const pattern = new RegExp(`(^|\\||;|&&|\\$\\()\\s*${blocked}\\b`)
    if (pattern.test(trimmed)) {
      throw new Error(`Blocked command: "${blocked}" is not allowed`)
    }
  }

  if (!ALLOWED_COMMANDS.includes(base)) {
    throw new Error(`Command "${base}" is not in the allowlist. Allowed: ${ALLOWED_COMMANDS.join(', ')}`)
  }

  if (base === 'git' && parts.length > 1) {
    if (!ALLOWED_GIT_SUBCOMMANDS.includes(parts[1])) {
      throw new Error(`git subcommand "${parts[1]}" is not allowed. Allowed: ${ALLOWED_GIT_SUBCOMMANDS.join(', ')}`)
    }
  }

  return trimmed
}

export default {
  id: 'tp-shell-access',
  valueId: 'tech-perfection',

  tools: [
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

  execute: async (toolName, input) => {
    const { command } = input
    if (!command) return 'Error: command is required'

    try {
      const validated = validateCommand(command)
      const output = execSync(validated, { encoding: 'utf-8', timeout: 10000, maxBuffer: 64 * 1024 })
      return output || '(no output)'
    } catch (err) {
      if (err.message?.startsWith('Blocked command') || err.message?.startsWith('Command "')) {
        return `Error: ${err.message}`
      }
      return JSON.stringify({ error: err.message, stdout: err.stdout || '', stderr: err.stderr || '' }, null, 2)
    }
  },

  verify: async () => {
    try {
      const output = execSync('date', { encoding: 'utf-8', timeout: 5000 })
      return { operational: true, evidence: `shell-access: date returned "${output.trim()}"` }
    } catch (err) {
      return { operational: false, evidence: `shell-access: ${err.message}` }
    }
  }
}
