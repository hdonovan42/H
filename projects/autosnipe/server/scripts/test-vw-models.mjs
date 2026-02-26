#!/usr/bin/env node

/**
 * test-vw-models.mjs
 *
 * Tests the new browser.js + cloudflare-solver.js pipeline by scraping
 * Volkswagen models from Autotrader. Uses the same extractModels logic
 * as build-models.mjs but with our Puppeteer+CU stack instead of ScrapingBee.
 *
 * Usage: cd server && DISPLAY=:99 node scripts/test-vw-models.mjs
 */

import * as cheerio from 'cheerio'
import 'dotenv/config'
import { getPage, closeBrowser } from '../browser.js'

const MAKE = 'Volkswagen'
const URL = `https://www.autotrader.co.uk/car-search?make=${encodeURIComponent(MAKE)}&advertising-location=at_cars`

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractModels(html, make) {
  const $ = cheerio.load(html)
  const models = new Set()

  $('[data-testid="search-listing-title"]').each((_, el) => {
    let title = $(el).text().trim()

    // Strip trailing price: ", £12,345"
    title = title.replace(/,?\s*£[\d,]+$/, '').trim()
    if (!title) return

    // Strip the make prefix
    const makePattern = new RegExp(`^${escapeRegex(make)}\\s+`, 'i')
    let remainder = title.replace(makePattern, '')
    if (remainder === title) return

    // Extract model name: everything before the engine spec
    const engineMatch = remainder.match(/\d+\.\d/)
    if (engineMatch) {
      remainder = remainder.slice(0, engineMatch.index).trim()
    }

    let model = remainder.trim()
    if (!model || model.length < 1) return

    models.add(model)
  })

  return [...models].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
}

async function main() {
  console.log(`\n=== Testing browser pipeline: ${MAKE} models ===\n`)
  console.log(`URL: ${URL}\n`)

  const start = Date.now()

  try {
    const result = await getPage(URL)
    const { html, cfSolved, cfCost, cfIterations } = result

    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`\n--- Results ---`)
    console.log(`HTML length: ${html.length} bytes`)
    console.log(`Cloudflare solved: ${cfSolved}`)
    console.log(`CF iterations: ${cfIterations}`)
    console.log(`CF cost: $${cfCost.toFixed(4)}`)
    console.log(`Time: ${elapsed}s`)

    // Extract models
    const models = extractModels(html, MAKE)
    console.log(`\nModels found (${models.length}):`)
    models.forEach(m => console.log(`  - ${m}`))

    // Also count raw listing cards for sanity
    const $ = cheerio.load(html)
    const cardCount = $('[data-testid*="advertCard"]').not('[data-testid*="skeleton"]').length
    const allTestIds = new Set()
    $('[data-testid]').each((_, el) => allTestIds.add($(el).attr('data-testid')))
    console.log(`\nRaw advert cards: ${cardCount}`)
    console.log(`Unique data-testid values (${allTestIds.size}): ${[...allTestIds].slice(0, 20).join(', ')}`)

    if (models.length === 0) {
      const bodyText = $('body').text().replace(/\s+/g, ' ').slice(0, 800)
      console.log('\nBody text (first 800 chars):')
      console.log(bodyText)
    }

  } catch (err) {
    console.error(`\nFailed: ${err.message}`)
    console.error(err.stack)
  } finally {
    await closeBrowser()
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
