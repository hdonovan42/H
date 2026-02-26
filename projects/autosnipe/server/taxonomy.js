// ===== LIVE AUTOTRADER TAXONOMY =====
// Navigates to Autotrader search pages in a CF-cleared browser session
// and captures the SearchResultsFacetsWithGroupsQuery GraphQL responses
// to extract model + trim facets with listing counts.

import { getBrowser } from './browser.js'
import { solveCloudflareTurnstile } from './cloudflare-solver.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TAXONOMY_PATH = path.join(__dirname, 'data', 'taxonomy.json')
const MAKES_PATH = path.join(__dirname, '..', 'src', 'data', 'makes.json')

const AT_SEARCH = 'https://www.autotrader.co.uk/car-search'
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const TRIM_LISTING_THRESHOLD = 50  // Only fetch trims for models with > this many listings
const MIN_TRIM_COUNT = 2           // Only include trims with >= this many listings
const PAGE_TIMEOUT = 30_000
const FACET_WAIT_TIMEOUT = 25_000

// ===== CF SESSION =====

async function solveCfSession() {
  const browser = await getBrowser()
  const page = await browser.newPage()
  await page.setUserAgent(USER_AGENT)

  try {
    console.log('[Taxonomy] Solving CF on seed page...')
    await page.goto(`${AT_SEARCH}?advertising-location=at_cars`, {
      waitUntil: 'networkidle2',
      timeout: 60_000
    })

    const title = await page.title()
    if (title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('cloudflare')) {
      const result = await solveCloudflareTurnstile(page)
      if (!result.solved) throw new Error('Cloudflare challenge failed')
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => {})
      await new Promise(r => setTimeout(r, 3000))
      console.log(`[Taxonomy] CF solved (cost: $${result.cost?.toFixed(4) || 0})`)
    } else {
      console.log('[Taxonomy] No CF challenge needed')
    }
  } finally {
    await page.close().catch(() => {})
  }
}

// ===== FACET CAPTURE =====

/**
 * Navigate to a URL and capture a specific facet from the
 * SearchResultsFacetsWithGroups GraphQL response.
 * @param {string} url - Autotrader search URL
 * @param {string} facetName - e.g. 'model' or 'aggregated_trim'
 * @returns {Array|null} - Array of { value, displayValue, count } or null
 */
async function captureFacet(url, facetName) {
  const browser = await getBrowser()
  const page = await browser.newPage()
  await page.setUserAgent(USER_AGENT)

  return new Promise((resolve) => {
    let resolved = false

    const cleanup = (result) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      page.close().catch(() => {})
      resolve(result)
    }

    const timer = setTimeout(() => {
      console.log(`[Taxonomy] Timeout waiting for ${facetName} facet`)
      cleanup(null)
    }, FACET_WAIT_TIMEOUT)

    // Listen for GraphQL responses BEFORE navigating
    // Autotrader batches two queries in one request — the response is an array:
    //   [0] = searchResults with listings
    //   [1] = searchResults with facets (sr.facets array)
    // Each facet: { facet: "model", filters: [{ options: [{ label, value, count }] }] }
    page.on('response', async (response) => {
      if (resolved) return
      if (!response.url().includes('at-gateway')) return

      try {
        const text = await response.text()
        let json
        try { json = JSON.parse(text) } catch { return }

        const responses = Array.isArray(json) ? json : [json]

        for (const resp of responses) {
          const facets = resp?.data?.searchResults?.facets
          if (!Array.isArray(facets)) continue

          const target = facets.find(f => f.facet === facetName)
          if (!target) continue

          const opts = target.filters?.[0]?.options || []
          cleanup(opts)
          return
        }
      } catch {
        // Not JSON or wrong shape — ignore
      }
    })

    // Navigate (CF cookies persist from seed page)
    page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT })
      .then(() => {
        // Network settled — if facet wasn't captured, give 3s more then give up
        setTimeout(() => cleanup(null), 3000)
      })
      .catch(() => cleanup(null))
  })
}

// ===== MAIN REFRESH =====

/**
 * Full taxonomy refresh — iterates all makes, captures model facets,
 * then drills into popular models for trim facets.
 */
export async function refreshTaxonomy() {
  console.log('[Taxonomy] Starting taxonomy refresh...')
  const startTime = Date.now()

  // Load makes list
  const makesData = JSON.parse(fs.readFileSync(MAKES_PATH, 'utf-8'))
  const makes = makesData.makes

  // Solve CF once — cookies persist for all subsequent page loads
  await solveCfSession()

  const taxonomy = {
    updatedAt: new Date().toISOString(),
    makes: {}
  }

  for (const make of makes) {
    console.log(`[Taxonomy] Fetching models for ${make.value}...`)

    const searchUrl = `${AT_SEARCH}?make=${encodeURIComponent(make.value)}&postcode=SW1A+1AA&advertising-location=at_cars`
    const modelOptions = await captureFacet(searchUrl, 'model')

    if (!modelOptions || modelOptions.length === 0) {
      console.log(`[Taxonomy] No model facets for ${make.value}, skipping`)
      taxonomy.makes[make.value] = { models: [] }
      await new Promise(r => setTimeout(r, 1500))
      continue
    }

    const models = modelOptions.map(opt => ({
      value: opt.value,
      label: opt.label || opt.value,
      count: opt.count || 0,
      trims: []
    }))

    console.log(`[Taxonomy] ${make.value}: ${models.length} models`)

    // Fetch trims for popular models
    for (const model of models) {
      if (model.count <= TRIM_LISTING_THRESHOLD) continue

      console.log(`[Taxonomy]   Fetching trims for ${make.value} ${model.value} (${model.count} listings)...`)
      const trimUrl = `${AT_SEARCH}?make=${encodeURIComponent(make.value)}&model=${encodeURIComponent(model.value)}&postcode=SW1A+1AA&advertising-location=at_cars`
      const trimOptions = await captureFacet(trimUrl, 'aggregated_trim')

      if (trimOptions && trimOptions.length > 0) {
        model.trims = trimOptions
          .filter(opt => (opt.count || 0) >= MIN_TRIM_COUNT)
          .map(opt => ({
            value: opt.value,
            label: opt.label || opt.value,
            count: opt.count || 0
          }))
        console.log(`[Taxonomy]   ${model.value}: ${model.trims.length} trims`)
      }

      // Pause between trim requests
      await new Promise(r => setTimeout(r, 1000))
    }

    taxonomy.makes[make.value] = { models }

    // Pause between makes
    await new Promise(r => setTimeout(r, 1500))
  }

  // Write to disk
  fs.writeFileSync(TAXONOMY_PATH, JSON.stringify(taxonomy, null, 2))

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const makeCount = Object.keys(taxonomy.makes).length
  const totalModels = Object.values(taxonomy.makes).reduce((sum, m) => sum + m.models.length, 0)
  const totalTrims = Object.values(taxonomy.makes).reduce((sum, m) =>
    sum + m.models.reduce((s, mod) => s + mod.trims.length, 0), 0)
  console.log(`[Taxonomy] Complete: ${makeCount} makes, ${totalModels} models, ${totalTrims} trims in ${elapsed}s`)

  return taxonomy
}

// ===== HELPERS =====

/** Get the cached taxonomy, or null if not available. */
export function getTaxonomy() {
  try {
    return JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf-8'))
  } catch {
    return null
  }
}

/** Check if taxonomy needs refreshing (missing or >8 days old). */
export function taxonomyNeedsRefresh() {
  const taxonomy = getTaxonomy()
  if (!taxonomy) return true
  const age = Date.now() - new Date(taxonomy.updatedAt).getTime()
  return age > 8 * 24 * 60 * 60 * 1000
}
