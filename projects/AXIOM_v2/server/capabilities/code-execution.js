import vm from 'node:vm'

export default {
  id: 'tp-code-exec',
  valueId: 'tech-perfection',

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
    }
  ],

  execute: async (toolName, input) => {
    const { code } = input
    if (!code) return 'Error: code is required'

    const logs = []
    const sandbox = {
      console: {
        log: (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
        error: (...args) => logs.push('[ERROR] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
        warn: (...args) => logs.push('[WARN] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))
      },
      JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set, Promise,
      parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
      setTimeout: undefined, setInterval: undefined
    }

    try {
      const script = new vm.Script(code, { timeout: 10000 })
      const ctx = vm.createContext(sandbox)
      const result = script.runInContext(ctx, { timeout: 10000 })

      return JSON.stringify({
        stdout: logs.join('\n'),
        returnValue: result !== undefined ? String(result) : undefined
      }, null, 2)
    } catch (err) {
      return JSON.stringify({ error: err.message, stdout: logs.join('\n') }, null, 2)
    }
  },

  verify: async () => {
    try {
      const sandbox = { result: null }
      const script = new vm.Script('result = 1 + 1', { timeout: 5000 })
      const ctx = vm.createContext(sandbox)
      script.runInContext(ctx, { timeout: 5000 })
      return {
        operational: sandbox.result === 2,
        evidence: sandbox.result === 2 ? 'code-execution: 1+1=2' : 'code-execution: unexpected result'
      }
    } catch (err) {
      return { operational: false, evidence: `code-execution: ${err.message}` }
    }
  }
}
