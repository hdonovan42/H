import { spawnSync } from 'node:child_process'

const ALLOWED_COMMANDS = [
  'ls', 'cat', 'head', 'tail', 'wc', 'date', 'uptime', 'df', 'free',
  'pm2', 'curl', 'node', 'npm', 'git', 'mkdir', 'which', 'rsync'
]
const BLOCKED_COMMANDS = [
  'rm', 'mv', 'cp', 'chmod', 'chown', 'kill', 'reboot', 'shutdown',
  'dd', 'mkfs', 'fdisk', 'mount', 'umount', 'passwd', 'su', 'sudo',
  'bash', 'sh', 'zsh', 'eval', 'exec'
]
const ALLOWED_GIT_SUBCOMMANDS = ['log', 'status', 'diff']

// Quote-aware tokenizer. Not a shell — no variable expansion, no escapes.
// Single and double quotes group tokens that contain whitespace.
function tokenize(str) {
  const tokens = []
  let current = ''
  let quote = null
  let inToken = false
  for (const ch of str) {
    if (quote) {
      if (ch === quote) { quote = null }
      else { current += ch }
    } else if (ch === "'" || ch === '"') {
      quote = ch
      inToken = true
    } else if (/\s/.test(ch)) {
      if (inToken) { tokens.push(current); current = ''; inToken = false }
    } else {
      current += ch
      inToken = true
    }
  }
  if (quote) throw new Error('Unterminated quote in command')
  if (inToken) tokens.push(current)
  return tokens
}

function validateAndTokenize(cmd) {
  const trimmed = cmd.trim()

  // Reject shell metacharacters that would chain or redirect — even though we
  // use execFile (shell: false), these are never valid here.
  if (/[;`\n\r]|&&|\|\||\$\(|[<>]|(^|\s)\|/.test(trimmed)) {
    throw new Error('Shell metacharacters (;, &&, ||, |, $(, `, <, >, newline) are not allowed')
  }

  const parts = tokenize(trimmed)
  if (parts.length === 0) throw new Error('Empty command')
  const base = parts[0]

  if (BLOCKED_COMMANDS.includes(base)) {
    throw new Error(`Blocked command: "${base}" is not allowed`)
  }
  if (!ALLOWED_COMMANDS.includes(base)) {
    throw new Error(`Command "${base}" is not in the allowlist. Allowed: ${ALLOWED_COMMANDS.join(', ')}`)
  }

  if (base === 'git' && parts.length > 1) {
    if (!ALLOWED_GIT_SUBCOMMANDS.includes(parts[1])) {
      throw new Error(`git subcommand "${parts[1]}" is not allowed. Allowed: ${ALLOWED_GIT_SUBCOMMANDS.join(', ')}`)
    }
  }

  return parts
}

export default {
  id: 'tp-shell-access',
  valueId: 'tech-perfection',

  tools: [
    {
      name: 'exec_command',
      description: 'Execute allowlisted shell commands with 10s timeout. No shell interpretation — metacharacters (|, ;, &&, $(), etc.) are rejected. Allowed: ls, cat, head, tail, wc, date, uptime, df, free, pm2, curl, node, npm, git (log/status/diff only), mkdir, which, rsync.',
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

    let tokens
    try {
      tokens = validateAndTokenize(command)
    } catch (err) {
      return `Error: ${err.message}`
    }
    const [bin, ...args] = tokens

    const result = spawnSync(bin, args, {
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 64 * 1024,
      shell: false,
    })

    if (result.error) {
      return JSON.stringify({ error: result.error.message, stdout: result.stdout || '', stderr: result.stderr || '' }, null, 2)
    }

    const merged = [result.stdout, result.stderr].filter(Boolean).join('').trim()
    if (result.status !== 0) {
      return `Error (exit ${result.status}): ${merged || '(no output)'}`
    }

    const capped = merged.length > 8192
      ? merged.slice(0, 8192) + '\n... [truncated — full output was ' + merged.length + ' chars]'
      : merged
    return capped || '(no output)'
  },

  verify: async () => {
    const r = spawnSync('date', [], { encoding: 'utf-8', timeout: 5000, shell: false })
    if (r.error || r.status !== 0) {
      return { operational: false, evidence: `shell-access: ${r.error?.message || r.stderr || 'non-zero exit'}` }
    }
    return { operational: true, evidence: `shell-access: date returned "${r.stdout.trim()}"` }
  }
}
