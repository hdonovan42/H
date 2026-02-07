export default {
  id: 'tp-http-client',
  valueId: 'tech-perfection',

  tools: [
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
    }
  ],

  execute: async (toolName, input) => {
    const { url, method = 'GET', headers = {}, body } = input
    if (!url) return 'Error: url is required'

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)

      const opts = { method, headers, signal: controller.signal, redirect: 'follow' }
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
  },

  verify: async () => {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch('https://api.anthropic.com/', { method: 'HEAD', signal: controller.signal })
      clearTimeout(timeout)
      return { operational: true, evidence: `http-client: Anthropic API responded ${res.status}` }
    } catch (err) {
      return { operational: false, evidence: `http-client: ${err.name === 'AbortError' ? 'timeout' : err.message}` }
    }
  }
}
