import Anthropic from '@anthropic-ai/sdk'

const MODEL_MAP = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-5-20250929',
  haiku: 'claude-haiku-4-5-20251001'
}

let client = null

function getClient() {
  if (!client) {
    client = new Anthropic()
  }
  return client
}

export async function executeCall({ model, systemPrompt, userMessage, maxTokens = 1024, tools, messages }) {
  const modelId = MODEL_MAP[model]
  if (!modelId) {
    return { success: false, error: `Unknown model: ${model}` }
  }

  const startTime = Date.now()

  try {
    const params = {
      model: modelId,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: messages || [{ role: 'user', content: userMessage }]
    }

    if (tools && tools.length > 0) {
      params.tools = tools
    }

    const response = await getClient().messages.create(params)

    const duration = Date.now() - startTime

    const textParts = []
    let searchCount = 0

    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'server_tool_use') {
        console.log(`  [Tool] ${block.name}: ${JSON.stringify(block.input)}`)
      } else if (block.type === 'web_search_tool_result') {
        searchCount++
      }
    }

    if (response.usage?.server_tool_use?.web_search_requests) {
      searchCount = response.usage.server_tool_use.web_search_requests
    }

    const result = textParts.join('\n')

    return {
      success: true,
      result,
      tokens: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        total: response.usage.input_tokens + response.usage.output_tokens
      },
      model: modelId,
      duration,
      stopReason: response.stop_reason,
      searchCount
    }
  } catch (error) {
    const duration = Date.now() - startTime

    if (error.status === 429) {
      return { success: false, error: 'Rate limited — try again shortly', duration }
    }
    if (error.status === 529) {
      return { success: false, error: 'API overloaded — try again shortly', duration }
    }
    if (error.status === 401) {
      return { success: false, error: 'Invalid API key', duration }
    }

    return {
      success: false,
      error: error.message || 'Unknown API error',
      duration
    }
  }
}

export async function* executeCallStream({ model, systemPrompt, userMessage, maxTokens = 1024, tools, messages }) {
  const modelId = MODEL_MAP[model]
  if (!modelId) {
    yield { type: 'error', error: `Unknown model: ${model}` }
    return
  }

  const startTime = Date.now()

  try {
    const params = {
      model: modelId,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: messages || [{ role: 'user', content: userMessage }]
    }

    if (tools && tools.length > 0) {
      params.tools = tools
    }

    const stream = getClient().messages.stream(params)

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text }
        }
      } else if (event.type === 'content_block_start') {
        if (event.content_block?.type === 'server_tool_use') {
          yield { type: 'tool_use', name: event.content_block.name, input: event.content_block.input }
        }
      }
    }

    const finalMessage = await stream.finalMessage()
    const duration = Date.now() - startTime

    let searchCount = 0
    if (finalMessage.usage?.server_tool_use?.web_search_requests) {
      searchCount = finalMessage.usage.server_tool_use.web_search_requests
    }

    yield {
      type: 'done',
      tokens: {
        input: finalMessage.usage.input_tokens,
        output: finalMessage.usage.output_tokens,
        total: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens
      },
      duration,
      searchCount,
      stopReason: finalMessage.stop_reason
    }
  } catch (error) {
    const duration = Date.now() - startTime
    yield { type: 'error', error: error.message || 'Unknown streaming error', duration }
  }
}

export async function checkAvailableModels() {
  const available = []

  for (const [name, modelId] of Object.entries(MODEL_MAP)) {
    try {
      await getClient().messages.create({
        model: modelId,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }]
      })
      available.push(name)
    } catch {
      // Model not available
    }
  }

  return available
}

export const AVAILABLE_MODELS = Object.keys(MODEL_MAP)

export default { executeCall, executeCallStream, checkAvailableModels, AVAILABLE_MODELS }
