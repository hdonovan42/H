#!/usr/bin/env node

/**
 * build-models.mjs
 *
 * Scrapes Autotrader listing titles via ScrapingBee to extract model names
 * for each make. Writes src/data/models.json.
 *
 * Usage: cd server && node scripts/build-models.mjs
 * Cost: ~44 makes × 5 credits = 220 credits (one-off)
 */

import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import * as cheerio from 'cheerio'
import 'dotenv/config'

const __dirname = dirname(fileURLToPath(import.meta.url))
const makesPath = join(__dirname, '../../src/data/makes.json')
const outputPath = join(__dirname, '../../src/data/models.json')

const SCRAPINGBEE_URL = 'https://app.scrapingbee.com/api/v1/'

const makesData = JSON.parse(readFileSync(makesPath, 'utf-8'))
const makes = makesData.makes.map(m => m.value)

async function fetchPage(make) {
  const apiKey = process.env.SCRAPINGBEE_API_KEY
  if (!apiKey) throw new Error('SCRAPINGBEE_API_KEY not set')

  const targetUrl = `https://www.autotrader.co.uk/car-search?make=${encodeURIComponent(make)}&advertising-location=at_cars`

  const params = new URLSearchParams({
    api_key: apiKey,
    url: targetUrl,
    render_js: 'true',
    country_code: 'gb',
    wait: '8000'
  })

  const res = await fetch(`${SCRAPINGBEE_URL}?${params.toString()}`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ScrapingBee ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.text()
}

function extractModels(html, make) {
  const $ = cheerio.load(html)
  const models = new Set()

  $('[data-testid="search-listing-title"]').each((_, el) => {
    let title = $(el).text().trim()

    // Strip trailing price: ", £12,345"
    title = title.replace(/,?\s*£[\d,]+$/, '').trim()

    if (!title) return

    // The title format is: "Make ModelSpec" e.g. "BMW 3 Series2.0 320d SE"
    // Strip the make prefix (case-insensitive)
    const makePattern = new RegExp(`^${escapeRegex(make)}\\s+`, 'i')
    let remainder = title.replace(makePattern, '')

    if (remainder === title) return // make not found in title — skip

    // Extract model name: everything before the engine spec pattern
    // Engine specs: "2.0", "1.5", "0.0" or year-like "20" at word boundary
    // Also handles: trim levels glued on like "3 Series2.0" → "3 Series"
    const engineMatch = remainder.match(/\d+\.\d/)
    if (engineMatch) {
      remainder = remainder.slice(0, engineMatch.index).trim()
    }

    // Clean up any trailing whitespace/junk
    let model = remainder.trim()

    // If we still have nothing useful, skip
    if (!model || model.length < 1) return

    models.add(model)
  })

  return [...models].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function main() {
  console.log(`Building models for ${makes.length} makes...\n`)

  const result = {}
  let totalModels = 0
  let failures = 0

  for (const make of makes) {
    process.stdout.write(`  ${make}... `)
    try {
      const html = await fetchPage(make)
      const models = extractModels(html, make)

      result[make] = models.map(m => ({ value: m, label: m }))
      totalModels += models.length
      console.log(`${models.length} models: ${models.join(', ')}`)

      // Small delay to be polite
      await new Promise(r => setTimeout(r, 500))
    } catch (err) {
      console.log(`FAILED — ${err.message}`)
      result[make] = []
      failures++
    }
  }

  // Write output
  writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n')

  console.log(`\nDone! ${totalModels} models across ${makes.length} makes (${failures} failures)`)
  console.log(`Written to ${outputPath}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
