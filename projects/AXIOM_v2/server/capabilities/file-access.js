import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

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

export default {
  id: 'tp-file-access',
  valueId: 'tech-perfection',

  tools: [
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
    }
  ],

  execute: async (toolName, input) => {
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
          const content = readFileSync(fullPath, 'utf-8')
          if (content.length > 16384) {
            return content.slice(0, 16384) + '\n... [truncated — file is ' + content.length + ' chars]'
          }
          return content
        }
        case 'write': {
          if (content === undefined) return 'Error: content is required for write'
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
  },

  verify: async () => {
    try {
      ensureWorkspace()
      const testPath = resolve(WORKSPACE_DIR, '.verify-test')
      writeFileSync(testPath, 'verify')
      const data = readFileSync(testPath, 'utf-8')
      unlinkSync(testPath)
      return {
        operational: data === 'verify',
        evidence: data === 'verify' ? 'file-access: write/read/delete cycle OK' : 'file-access: read-back mismatch'
      }
    } catch (err) {
      return { operational: false, evidence: `file-access: ${err.message}` }
    }
  }
}
