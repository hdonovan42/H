import Anthropic from '@anthropic-ai/sdk'
import { MAX_AGENT_ITERATIONS } from '../shared/config.js'

const MODEL = 'claude-haiku-4-5-20251001'
const BETA = 'computer-use-2025-01-24'
const DISPLAY_WIDTH = 1280
const DISPLAY_HEIGHT = 800

// Haiku 4.5 pricing per million tokens
const INPUT_COST_PER_MTOK = 1.0
const OUTPUT_COST_PER_MTOK = 5.0
const CACHE_WRITE_COST_PER_MTOK = 1.25  // 1.25x input price
const CACHE_READ_COST_PER_MTOK = 0.1    // 0.1x input price

const SYSTEM_PROMPT = `You are looking at a web browser showing a Cloudflare verification page. Your ONLY job is to solve the Cloudflare Turnstile challenge so the page can load.

Look for:
- A checkbox or "Verify you are human" button — click it
- A CAPTCHA challenge — solve it
- Any "I'm not a robot" element — interact with it

Once you see the actual website content (car listings, search results), stop immediately — the challenge is solved.

Be precise with your clicks. Click the centre of interactive elements.`

function calcCost(usage) {
  if (!usage) return 0
  const input = (usage.input_tokens || 0) / 1_000_000
  const output = (usage.output_tokens || 0) / 1_000_000
  const cacheWrite = (usage.cache_creation_input_tokens || 0) / 1_000_000
  const cacheRead = (usage.cache_read_input_tokens || 0) / 1_000_000
  return input * INPUT_COST_PER_MTOK + output * OUTPUT_COST_PER_MTOK +
    cacheWrite * CACHE_WRITE_COST_PER_MTOK + cacheRead * CACHE_READ_COST_PER_MTOK
}

/**
 * Strip image blocks from all messages except the latest user message.
 * Replaces them with a lightweight text placeholder to avoid quadratic token growth.
 * Returns a shallow copy — original messages array is not modified.
 */
function stripOldScreenshots(messages) {
  if (messages.length <= 1) return messages

  const stripped = messages.map((msg, i) => {
    // Only strip from user messages (which contain screenshots)
    if (msg.role !== 'user') return msg
    // Keep the last message intact (it has the current screenshot)
    if (i === messages.length - 1) return msg

    const content = msg.content
    if (!Array.isArray(content)) return msg

    const hasImage = content.some(block =>
      block.type === 'image' ||
      (block.type === 'tool_result' && Array.isArray(block.content) && block.content.some(b => b.type === 'image'))
    )
    if (!hasImage) return msg

    const newContent = content.map(block => {
      if (block.type === 'image') {
        return { type: 'text', text: '[previous screenshot]' }
      }
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        return {
          ...block,
          content: block.content.map(b =>
            b.type === 'image' ? { type: 'text', text: '[previous screenshot]' } : b
          )
        }
      }
      return block
    })

    return { ...msg, content: newContent }
  })

  return stripped
}

async function executeAction(page, input) {
  const type = input.action || input.type

  switch (type) {
    case 'left_click': {
      const x = input.coordinate?.[0] ?? input.x
      const y = input.coordinate?.[1] ?? input.y
      if (x != null && y != null) {
        await page.mouse.click(x, y)
      }
      break
    }
    case 'right_click': {
      const x = input.coordinate?.[0] ?? input.x
      const y = input.coordinate?.[1] ?? input.y
      if (x != null && y != null) {
        await page.mouse.click(x, y, { button: 'right' })
      }
      break
    }
    case 'double_click': {
      const x = input.coordinate?.[0] ?? input.x
      const y = input.coordinate?.[1] ?? input.y
      if (x != null && y != null) {
        await page.mouse.click(x, y, { clickCount: 2 })
      }
      break
    }
    case 'type': {
      if (input.text) {
        await page.keyboard.type(input.text)
      }
      break
    }
    case 'key': {
      if (input.key) {
        // Map CU key names to Puppeteer key names
        const keyMap = { 'Return': 'Enter', 'space': 'Space' }
        const key = keyMap[input.key] || input.key
        await page.keyboard.press(key)
      }
      break
    }
    case 'scroll': {
      const x = input.coordinate?.[0] ?? DISPLAY_WIDTH / 2
      const y = input.coordinate?.[1] ?? DISPLAY_HEIGHT / 2
      const deltaX = input.delta?.[0] ?? 0
      const deltaY = input.delta?.[1] ?? 0
      await page.mouse.move(x, y)
      await page.mouse.wheel({ deltaX, deltaY })
      break
    }
    case 'wait': {
      await new Promise(r => setTimeout(r, (input.duration || 2) * 1000))
      break
    }
    case 'screenshot': {
      // No-op — we take screenshots at the start of each loop
      break
    }
    case 'mouse_move': {
      const x = input.coordinate?.[0] ?? input.x
      const y = input.coordinate?.[1] ?? input.y
      if (x != null && y != null) {
        await page.mouse.move(x, y)
      }
      break
    }
    default:
      console.log(`[CF-Solver] Unknown action type: ${type}`)
  }
}

/**
 * Solve a Cloudflare Turnstile challenge using Anthropic Computer Use.
 * @param {import('puppeteer').Page} page - Puppeteer page showing the CF challenge
 * @returns {{ solved: boolean, iterations: number, cost: number }}
 */
export async function solveCloudflareTurnstile(page) {
  const client = new Anthropic()
  let totalCost = 0
  let iterations = 0
  let lastToolUseId = null
  const messages = []

  console.log('[CF-Solver] Starting Cloudflare Turnstile solve')

  for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
    iterations = i + 1

    // Take screenshot
    const screenshot = await page.screenshot({ encoding: 'base64' })

    // Build message content
    if (i === 0) {
      // First turn — send screenshot as user message
      messages.push({
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: screenshot }
          },
          {
            type: 'text',
            text: 'Solve the Cloudflare verification challenge on this page. Click the checkbox or button to verify you are human.'
          }
        ]
      })
    } else {
      // Subsequent turns — send screenshot as tool_result
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: lastToolUseId,
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: screenshot }
              }
            ]
          }
        ]
      })
    }

    // Strip old screenshots to avoid quadratic token growth (keep only latest)
    const prunedMessages = stripOldScreenshots(messages)

    // Call Claude
    let response
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' }
          }
        ],
        tools: [
          {
            type: 'computer_20250124',
            name: 'computer',
            display_width_px: DISPLAY_WIDTH,
            display_height_px: DISPLAY_HEIGHT,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: prunedMessages,
        betas: [BETA]
      })
    } catch (err) {
      console.error(`[CF-Solver] API error on iteration ${iterations}:`, err.message)
      break
    }

    totalCost += calcCost(response.usage)

    // Log cache performance
    const u = response.usage || {}
    if (u.cache_read_input_tokens || u.cache_creation_input_tokens) {
      console.log(`[CF-Solver] Iteration ${iterations} cache: ${u.cache_read_input_tokens || 0} read, ${u.cache_creation_input_tokens || 0} write`)
    }

    // Add assistant response to messages
    messages.push({ role: 'assistant', content: response.content })

    // Process response blocks
    lastToolUseId = null
    let hasAction = false

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        lastToolUseId = block.id
        hasAction = true
        console.log(`[CF-Solver] Iteration ${iterations}: ${block.input.action}${block.input.coordinate ? ` at (${block.input.coordinate})` : ''}`)
        await executeAction(page, block.input)
        // Brief pause after action for page to react
        await new Promise(r => setTimeout(r, 1500))
      } else if (block.type === 'text' && block.text) {
        console.log(`[CF-Solver] Claude: ${block.text.slice(0, 100)}`)
      }
    }

    // Check if CF is cleared (page title changes from challenge page)
    const title = await page.title()
    if (!title.toLowerCase().includes('just a moment') && !title.toLowerCase().includes('cloudflare')) {
      console.log(`[CF-Solver] Cloudflare cleared after ${iterations} iteration(s), cost: $${totalCost.toFixed(4)}`)
      return { solved: true, iterations, cost: totalCost }
    }

    // If Claude didn't use any tools, it's stuck
    if (!hasAction || response.stop_reason === 'end_turn') {
      console.log('[CF-Solver] No more actions from Claude, stopping')
      break
    }
  }

  console.log(`[CF-Solver] Failed after ${iterations} iteration(s), cost: $${totalCost.toFixed(4)}`)
  return { solved: false, iterations, cost: totalCost }
}
