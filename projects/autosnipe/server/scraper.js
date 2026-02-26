// ===== AUTOTRADER GRAPHQL API SCRAPER =====
// Solves Cloudflare once via Puppeteer, then makes GraphQL
// fetch() calls from within the browser context.

import { getBrowser } from './browser.js'
import { solveCloudflareTurnstile } from './cloudflare-solver.js'

const AT_GATEWAY = '/at-gateway'
const CF_SEED_URL = 'https://www.autotrader.co.uk/car-search?advertising-location=at_cars'

// ===== URL BUILDER (still used for autotrader_url column) =====

export function buildAutotraderUrl(criteria) {
  const params = new URLSearchParams()

  params.set('postcode', criteria.postcode || 'SW1A 1AA')
  params.set('radius', criteria.radius ? String(criteria.radius) : '1500')
  if (criteria.make) params.set('make', criteria.make)
  if (criteria.model) params.set('model', criteria.model)
  if (criteria.year_from) params.set('year-from', String(criteria.year_from))
  if (criteria.year_to) params.set('year-to', String(criteria.year_to))
  if (criteria.price_from) params.set('price-from', String(criteria.price_from))
  if (criteria.price_to) params.set('price-to', String(criteria.price_to))
  if (criteria.mileage_max) params.set('maximum-mileage', String(criteria.mileage_max))
  if (criteria.fuel_type) params.set('fuel-type', criteria.fuel_type)
  if (criteria.transmission) params.set('transmission', criteria.transmission)

  params.set('sort', 'relevance')
  params.set('advertising-location', 'at_cars')

  return `https://www.autotrader.co.uk/car-search?${params.toString()}`
}

// ===== GRAPHQL QUERY BUILDER =====

function buildFilters(criteria) {
  const filters = [
    { filter: 'postcode', selected: [String(criteria.postcode || 'SW1A1AA').replace(/\s/g, '')] },
    { filter: 'advertising_location', selected: ['at_cars'] },
    { filter: 'price_search_type', selected: ['total'] }
  ]

  if (criteria.make) filters.push({ filter: 'make', selected: [criteria.make] })
  if (criteria.model) filters.push({ filter: 'model', selected: [criteria.model] })
  if (criteria.year_from) filters.push({ filter: 'min_year_manufactured', selected: [String(criteria.year_from)] })
  if (criteria.year_to) filters.push({ filter: 'max_year_manufactured', selected: [String(criteria.year_to)] })
  if (criteria.price_from) filters.push({ filter: 'min_price', selected: [String(criteria.price_from)] })
  if (criteria.price_to) filters.push({ filter: 'max_price', selected: [String(criteria.price_to)] })
  if (criteria.mileage_max) filters.push({ filter: 'max_mileage', selected: [String(criteria.mileage_max)] })
  if (criteria.fuel_type) filters.push({ filter: 'fuel_type', selected: [criteria.fuel_type] })
  if (criteria.transmission) filters.push({ filter: 'transmission', selected: [criteria.transmission] })
  if (criteria.radius) filters.push({ filter: 'distance', selected: [String(criteria.radius)] })

  return filters
}

function buildQuery(filters, page = 1) {
  const filtersStr = filters
    .map(f => `{filter: ${f.filter}, selected: [${f.selected.map(v => `"${v}"`).join(', ')}]}`)
    .join(', ')

  return `{
    searchResults(input: {
      facets: [],
      filters: [${filtersStr}],
      channel: cars,
      page: ${page},
      sortBy: relevance,
      searchId: "autosnipe-${Date.now()}"
    }) {
      page { number count results { count } }
      listings {
        ... on SearchListing {
          advertId title subTitle attentionGrabber price
          vehicleLocation images sellerType fpaLink
          badges { type displayText }
          trackingContext {
            advertContext { id make model year condition price }
            distance { distance }
          }
        }
      }
    }
  }`
}

// ===== CLOUDFLARE SESSION =====

let cfPage = null

async function ensureCfSession() {
  const b = await getBrowser()

  // Reuse existing page if still open
  if (cfPage && !cfPage.isClosed()) {
    // Quick health check — try a small fetch
    const ok = await cfPage.evaluate(async (gw) => {
      try {
        const r = await fetch(gw, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: '{ __typename }' })
        })
        return r.status !== 403
      } catch { return false }
    }, AT_GATEWAY).catch(() => false)

    if (ok) return cfPage
    console.log('[Scraper] CF session expired, re-solving...')
    await cfPage.close().catch(() => {})
    cfPage = null
  }

  // Open a fresh page and solve Cloudflare
  console.log('[Scraper] Solving Cloudflare challenge...')
  const page = await b.newPage()
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

  await page.goto(CF_SEED_URL, { waitUntil: 'networkidle2', timeout: 60_000 })

  const title = await page.title()
  if (title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('cloudflare')) {
    const result = await solveCloudflareTurnstile(page)
    if (!result.solved) {
      await page.close().catch(() => {})
      throw new Error('Cloudflare challenge failed')
    }
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => {})
    // Brief pause for page to fully settle
    await new Promise(r => setTimeout(r, 3000))
    console.log(`[Scraper] CF solved (cost: $${result.cost?.toFixed(4) || 0})`)
  } else {
    console.log('[Scraper] No CF challenge needed')
  }

  cfPage = page
  return page
}

// ===== RESPONSE PARSER =====

function parseListings(data) {
  const results = []
  const listings = data?.data?.searchResults?.listings || []

  for (const listing of listings) {
    if (!listing.advertId) continue

    const ctx = listing.trackingContext?.advertContext || {}
    const badges = listing.badges || []

    // Mileage from badges
    const mileageBadge = badges.find(b => b.type === 'MILEAGE')
    const mileageMatch = mileageBadge?.displayText?.match(/([\d,]+)\s*miles/i)
    const mileage = mileageMatch ? parseInt(mileageMatch[1].replace(/,/g, '')) : null

    // Fuel type and transmission from subtitle
    const subtitle = listing.subTitle || ''
    const fuelMatch = subtitle.match(/\b(Petrol|Diesel|Electric|Hybrid|Plug-in Hybrid)\b/i)
    const transMatch = subtitle.match(/\b(Automatic|Manual|Auto)\b/i)
    const transmission = transMatch ? (transMatch[1] === 'Auto' ? 'Automatic' : transMatch[1]) : null

    // Image URL
    const rawImage = listing.images?.[0] || ''
    const imageUrl = rawImage.replace('{resize}', '800x600') || null

    const title = listing.title || `${ctx.make || ''} ${ctx.model || ''}`.trim()

    results.push({
      autotrader_id: listing.advertId,
      title,
      price: ctx.price || null,
      mileage,
      year: ctx.year || null,
      fuel_type: fuelMatch ? fuelMatch[1] : null,
      transmission,
      url: `https://www.autotrader.co.uk${listing.fpaLink?.split('?')[0] || `/car-details/${listing.advertId}`}`,
      image_url: imageUrl,
      seller_type: listing.sellerType || null,
      location: listing.vehicleLocation || null
    })
  }

  return results
}

// ===== SCRAPER =====

export async function scrapeSearch(search) {
  const criteria = JSON.parse(search.criteria)
  const filters = buildFilters(criteria)
  const query = buildQuery(filters, 1)

  console.log(`[Scraper] Search #${search.id}: querying GraphQL API`)

  try {
    const page = await ensureCfSession()

    // Execute fetch inside the browser context (uses CF-cleared cookies)
    const raw = await page.evaluate(async (gw, gqlQuery) => {
      const res = await fetch(gw, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: gqlQuery })
      })
      if (!res.ok) return { error: `API returned ${res.status}` }
      return { data: await res.json() }
    }, AT_GATEWAY, query)

    if (raw.error) {
      // CF session likely expired — clear it so next call re-solves
      if (cfPage && !cfPage.isClosed()) await cfPage.close().catch(() => {})
      cfPage = null
      throw new Error(raw.error)
    }

    const data = raw.data
    if (data.errors) {
      throw new Error(`GraphQL error: ${data.errors[0]?.message || 'unknown'}`)
    }

    const listings = parseListings(data)
    const totalResults = data?.data?.searchResults?.page?.results?.count || listings.length

    console.log(`[Scraper] Search #${search.id}: ${listings.length} listings (${totalResults} total)`)
    return { listings, iterations: 1, success: true, cost: 0 }

  } catch (err) {
    console.error(`[Scraper] Search #${search.id} failed:`, err.message)
    return { listings: [], iterations: 1, success: false, cost: 0 }
  }
}
