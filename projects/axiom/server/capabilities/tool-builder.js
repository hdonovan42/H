import { readdirSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const USER_TOOLS_DIR = resolve(__dirname, 'user-tools')

export default {
  actuatorId: 'tool-creation',

  tools: [
    {
      name: 'save_tool',
      description: 'Save a new capability tool module to the user-tools directory. The module must export a default object with: name, description, input_schema, execute(input, context), verify(context).',
      input_schema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Filename for the tool (e.g. "my-tool.js")' },
          code: { type: 'string', description: 'JavaScript module source code implementing the tool interface' }
        },
        required: ['filename', 'code']
      }
    },
    {
      name: 'list_tools',
      description: 'List all user-created tools in the user-tools directory',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  ],

  execute: async (toolName, input, context) => {
    if (toolName === 'list_tools') {
      mkdirSync(USER_TOOLS_DIR, { recursive: true })
      const files = readdirSync(USER_TOOLS_DIR).filter(f => f.endsWith('.js'))

      if (files.length === 0) {
        return 'No user-created tools exist yet.'
      }

      const tools = []
      for (const file of files) {
        try {
          const content = readFileSync(resolve(USER_TOOLS_DIR, file), 'utf-8')
          // Extract name and description from the source
          const nameMatch = content.match(/name:\s*['"]([^'"]+)['"]/)
          const descMatch = content.match(/description:\s*['"]([^'"]+)['"]/)
          tools.push({
            filename: file,
            name: nameMatch ? nameMatch[1] : file,
            description: descMatch ? descMatch[1] : 'No description'
          })
        } catch {
          tools.push({ filename: file, name: file, description: 'Error reading tool' })
        }
      }

      return JSON.stringify({ count: tools.length, tools }, null, 2)
    }

    if (toolName === 'save_tool') {
      const { filename, code } = input
      if (!filename || !code) return 'Error: filename and code are required'

      // Sanitise filename
      const safeName = filename.replace(/[^a-zA-Z0-9_-]/g, '').replace(/^-+/, '') + (filename.endsWith('.js') ? '' : '.js')
      if (safeName.length < 4) return 'Error: filename too short'

      // Basic validation — must contain the required interface elements
      if (!code.includes('export default') && !code.includes('module.exports')) {
        return 'Error: tool must use export default or module.exports'
      }

      mkdirSync(USER_TOOLS_DIR, { recursive: true })
      const toolPath = resolve(USER_TOOLS_DIR, safeName)
      writeFileSync(toolPath, code)

      return `Tool saved to user-tools/${safeName}. It will be loaded on next registry initialisation.`
    }

    return `Unknown tool: ${toolName}`
  },

  verify: async (context) => {
    mkdirSync(USER_TOOLS_DIR, { recursive: true })
    const files = readdirSync(USER_TOOLS_DIR).filter(f => f.endsWith('.js'))

    if (files.length > 0) {
      return {
        operational: true,
        evidence: `${files.length} user-created tool(s) exist in user-tools/`
      }
    }

    return {
      operational: false,
      evidence: 'No user-created tools exist yet'
    }
  }
}
