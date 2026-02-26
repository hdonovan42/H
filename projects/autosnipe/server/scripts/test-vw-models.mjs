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
const PAGES = [
  `https://www.autotrader.co.uk/car-search?postcode=SW1A+1AA&radius=1500&make=${encodeURIComponent(MAKE)}&sort=relevance&advertising-location=at_cars`,
  `https://www.autotrader.co.uk/car-search?postcode=SW1A+1AA&radius=1500&make=${encodeURIComponent(MAKE)}&sort=relevance&advertising-location=at_cars&page=2`,
  `https://www.autotrader.co.uk/car-search?postcode=SW1A+1AA&radius=1500&make=${encodeURIComponent(MAKE)}&sort=relevance&advertising-location=at_cars&page=3`,
  `https://www.autotrader.co.uk/car-search?postcode=SW1A+1AA&radius=1500&make=${encodeURIComponent(MAKE)}&sort=relevance&advertising-location=at_cars&page=5`,
  `https://www.autotrader.co.uk/car-search?postcode=SW1A+1AA&radius=1500&make=${encodeURIComponent(MAKE)}&sort=relevance&advertising-location=at_cars&page=10`,
]

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
  console.log(`\n=== Testing browser pipeline: ${MAKE} models (${PAGES.length} pages) ===\n`)

  const start = Date.now()
  const allModels = new Set()
  let totalCost = 0
  let totalCards = 0

  try {
    for (let i = 0; i < PAGES.length; i++) {
      const pageUrl = PAGES[i]
      console.log(`\n--- Page ${i + 1}/${PAGES.length} ---`)

      const { html, cfSolved, cfCost } = await getPage(pageUrl)
      totalCost += cfCost

      const models = extractModels(html, MAKE)
      models.forEach(m => allModels.add(m))

      const $ = cheerio.load(html)
      const cardCount = $('[data-testid*="advertCard"]').not('[data-testid*="skeleton"]').length
      totalCards += cardCount

      console.log(`  ${cardCount} cards, ${models.length} models, CF: ${cfSolved ? `solved ($${cfCost.toFixed(4)})` : 'not needed'}`)
      console.log(`  Models: ${models.join(', ')}`)

      // Brief pause between pages
      if (i < PAGES.length - 1) await new Promise(r => setTimeout(r, 2000))
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    const sorted = [...allModels].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))

    console.log(`\n=== FINAL RESULTS ===`)
    console.log(`Total cards: ${totalCards}`)
    console.log(`Total CF cost: $${totalCost.toFixed(4)}`)
    console.log(`Time: ${elapsed}s`)
    console.log(`\nAll models found (${sorted.length}):`)
    sorted.forEach(m => console.log(`  - ${m}`))

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
