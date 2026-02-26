#!/usr/bin/env node
import { writeFileSync } from 'fs'
import * as cheerio from 'cheerio'
import 'dotenv/config'

const apiKey = process.env.SCRAPINGBEE_API_KEY
const make = process.argv[2] || 'BMW'
const targetUrl = `https://www.autotrader.co.uk/car-search?postcode=SW1A+1AA&make=${encodeURIComponent(make)}&advertising-location=at_cars`

const params = new URLSearchParams({
  api_key: apiKey,
  url: targetUrl,
  render_js: 'true',
  country_code: 'gb',
  wait: '8000',
  premium_proxy: 'true'
})

console.log(`Fetching ${make}...`)
const res = await fetch(`https://app.scrapingbee.com/api/v1/?${params.toString()}`)
const html = await res.text()
writeFileSync('/tmp/autotrader-debug.html', html)
console.log(`Saved ${html.length} bytes to /tmp/autotrader-debug.html`)

const $ = cheerio.load(html)

// 1. Listing titles
const titles = $('[data-testid="search-listing-title"]')
console.log(`\n--- Listing titles: ${titles.length} ---`)
titles.each((i, el) => {
  if (i < 10) console.log(`  "${$(el).text().trim()}"`)
})

// 2. Look for model filter/dropdown in page
console.log(`\n--- Script tags with model/filter data ---`)
$('script').each((i, el) => {
  const text = $(el).html() || ''
  if (text.includes('model') && text.length > 100 && text.length < 50000) {
    // Look for JSON-like arrays with model names
    const modelMatch = text.match(/"model[^"]*":\s*\[([^\]]{10,500})\]/)
    if (modelMatch) {
      console.log(`  Script ${i} (${text.length} chars): model data found:`)
      console.log(`    ${modelMatch[0].slice(0, 300)}`)
    }
  }
})

// 3. Look for select/option elements that might be model filter
console.log(`\n--- Select elements ---`)
$('select').each((i, el) => {
  const $sel = $(el)
  const name = $sel.attr('name') || $sel.attr('id') || $sel.attr('data-testid') || `select-${i}`
  const opts = $sel.find('option').map((_, o) => $(o).text().trim()).get()
  if (opts.length > 2 && opts.length < 100) {
    console.log(`  ${name}: ${opts.length} options — ${opts.slice(0, 8).join(', ')}${opts.length > 8 ? '...' : ''}`)
  }
})

// 4. Look for data attributes with "model" in testid
console.log(`\n--- data-testid containing "model" ---`)
$('[data-testid*="model" i], [data-testid*="Model" i]').each((i, el) => {
  const $el = $(el)
  console.log(`  ${el.tagName}[data-testid="${$el.attr('data-testid')}"]: "${$el.text().trim().slice(0, 100)}"`)
})

// 5. Look for button/link elements in filter area
console.log(`\n--- Filter-related elements ---`)
$('[data-testid*="filter"], [class*="filter"]').each((i, el) => {
  if (i < 10) {
    const $el = $(el)
    const text = $el.text().trim().slice(0, 100)
    if (text) console.log(`  ${el.tagName}[${$el.attr('data-testid') || $el.attr('class')?.slice(0, 40)}]: "${text}"`)
  }
})
