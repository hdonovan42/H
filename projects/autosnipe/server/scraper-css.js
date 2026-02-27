// ===== AUTOTRADER CSS CORE SEARCH FALLBACK =====
// Uses the CSS (Core Search Service) endpoint from the same CWS API.
// Same auth, same host — different search path with a different response shape.
// Acts as a zero-latency fallback when SSS is down or deprecated.
//
// STATUS: Experimental. The CSS endpoint requires POST with
// application/x-www-form-urlencoded WITHOUT charset=UTF-8 suffix.
// Node.js fetch/undici always appends charset, so we shell out to curl.
// Server returns 500 for application/json bodies.
// The response parser + field mapping are ready based on APK decompilation.

import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  CWS_BASE,
  COMPOSABLE_VERSION,
  getAccessToken,
  buildHeaders,
} from './scraper.js'

const execFileAsync = promisify(execFile)

const CSS_PATH = `css/api/${COMPOSABLE_VERSION}/core-search/1/search`
const CSS_PAGE_SIZE = 20
const MAX_PAGES = 5

// ===== CSS SEARCH CRITERIA BUILDER =====
// CSS uses array types for make, model, colour, fuelType, transmission, bodyType
// and string types for year fields (per APK SearchCriteria$$serializer.java).

function buildCssSearchCriteria(criteria) {
  const sc = {}

  sc.postcode = String(criteria.postcode || 'SW1A1AA').replace(/\s/g, '')
  if (criteria.radius) sc.distance = Number(criteria.radius)
  if (criteria.make) sc.make = [criteria.make]
  if (criteria.model) sc.model = [criteria.model]
  if (criteria.variant) sc.modelVariant = [criteria.variant]
  if (criteria.year_from) sc.minYearManufactured = String(criteria.year_from)
  if (criteria.year_to) sc.maxYearManufactured = String(criteria.year_to)
  if (criteria.price_from) sc.minPrice = Number(criteria.price_from)
  if (criteria.price_to) sc.maxPrice = Number(criteria.price_to)
  if (criteria.mileage_max) sc.maxMileage = Number(criteria.mileage_max)
  if (criteria.fuel_type) sc.fuelType = [criteria.fuel_type]
  if (criteria.transmission) sc.transmission = [criteria.transmission]
  if (criteria.body_type) sc.bodyType = [criteria.body_type]
  if (criteria.doors) sc.doorsValues = [criteria.doors]
  if (criteria.colour) sc.colour = [criteria.colour]
  if (criteria.exclude_cat) sc.excludeCatScdn = true

  return sc
}

// ===== CSS RESPONSE PARSER =====

function parseMileageFromKeyFacts(keyFacts) {
  if (!keyFacts) return null
  // Format: "2019 · 45,000 miles · Petrol · Automatic"
  const match = keyFacts.match(/([\d,]+)\s*miles/i)
  if (!match) return null
  return parseInt(match[1].replace(/,/g, ''), 10) || null
}

function parseTransmissionFromKeyFacts(keyFacts) {
  if (!keyFacts) return null
  const match = keyFacts.match(/\b(Automatic|Manual|Auto|Steptronic|DCT|PDK|DSG|CVT|Tiptronic)\b/i)
  if (!match) return null
  return match[1] === 'Manual' ? 'Manual' : 'Automatic'
}

export function parseCssListings(data, criteria = {}) {
  const results = []
  const listings = data?.searchResults || []

  for (const listing of listings) {
    const id = listing.id || listing.tracking?.advertId
    if (!id) continue

    const tracking = listing.tracking || {}
    const vehicle = tracking.vehicle || {}
    const keyFacts = listing.keyFacts || ''

    // Price: prefer numeric from tracking, fall back to parsing formatted
    let price = tracking.price || null
    if (!price && listing.priceFormatted) {
      const priceMatch = listing.priceFormatted.replace(/[£,\s]/g, '')
      price = parseInt(priceMatch, 10) || null
    }

    // Mileage: parse from keyFacts
    const mileage = parseMileageFromKeyFacts(keyFacts)

    // Fuel type: criteria first (AT filtered on it), then tracking, then keyFacts
    let fuelType = criteria.fuel_type || vehicle.fuelType || null
    if (!fuelType) {
      const fuelMatch = keyFacts.match(/\b(Petrol|Diesel|Electric|Hybrid|Plug-in Hybrid)\b/i)
      fuelType = fuelMatch ? fuelMatch[1] : null
    }

    // Transmission: criteria first, then keyFacts
    let transmission = criteria.transmission || null
    if (!transmission) {
      transmission = parseTransmissionFromKeyFacts(keyFacts)
    }

    // Image URL: CSS returns plain URLs (no template)
    const imageUrl = listing.imageUrls?.[0] || null

    // URL: prepend base if relative
    let url = listing.productDetailPageUri || null
    if (url && !url.startsWith('http')) {
      url = `https://www.autotrader.co.uk${url}`
    }
    if (!url) url = `https://www.autotrader.co.uk/car-details/${id}`

    results.push({
      autotrader_id: String(id),
      title: listing.title || `${vehicle.make || ''} ${vehicle.model || ''}`.trim(),
      price,
      mileage,
      year: vehicle.year || null,
      fuel_type: fuelType,
      transmission,
      url,
      image_url: imageUrl,
      seller_type: tracking.advertiserType || null,
      location: listing.location || null
    })
  }

  return results
}

// ===== CSS FETCH VIA CURL =====
// Node.js fetch appends charset=UTF-8 to Content-Type which the CSS
// endpoint rejects with 415. Shell out to curl for exact header control.

async function cssCurlFetch(path, formBody, token, headers) {
  const url = `${CWS_BASE}/${path}`

  const args = [
    '-s', '--http1.1',
    '-X', 'POST', url,
    '-H', 'Content-Type: application/x-www-form-urlencoded',
    '-H', `Accept: application/json`,
    '-H', `Access-Token: ${token}`,
    '-H', `channel: ${headers.channel || 'Cars'}`,
    '-H', `sessionId: ${headers.sessionId}`,
    '-H', `deviceId: ${headers.deviceId}`,
    '-H', `platform: android`,
    '-H', `platform-version: ${headers['platform-version']}`,
    '-H', `platform-os-version: ${headers['platform-os-version'] || '14'}`,
    '-H', `composableVersion: ${headers.composableVersion}`,
    '-H', `User-Agent: ${headers['User-Agent']}`,
    '-d', formBody,
    '-w', '\n%{http_code}',
  ]

  const { stdout } = await execFileAsync('curl', args, { timeout: 15000 })

  // Last line is the HTTP status code
  const lines = stdout.trimEnd().split('\n')
  const statusCode = parseInt(lines.pop(), 10)
  const body = lines.join('\n')

  if (statusCode >= 400) {
    throw new Error(`CSS API returned ${statusCode}`)
  }

  return JSON.parse(body)
}

// ===== CSS SEARCH =====

export async function cssSearch(search) {
  const criteria = JSON.parse(search.criteria)

  console.log(`[Scraper-CSS] Search #${search.id}: querying CSS Core Search API`)

  const startTime = Date.now()

  const token = await getAccessToken()
  const headers = buildHeaders(token)
  const searchCriteria = buildCssSearchCriteria(criteria)
  const allListings = []

  // Build form body for page 0 (CSS is 0-indexed)
  const baseParams = new URLSearchParams({
    searchCriteria: JSON.stringify(searchCriteria),
    selectedSortOption: 'datedesc',
    page: '0',
    pageSize: String(CSS_PAGE_SIZE),
  })

  const data = await cssCurlFetch(CSS_PATH, baseParams.toString(), token, headers)

  const totalPages = data?.page?.totalPages || 1
  allListings.push(...parseCssListings(data, criteria))

  // Fetch remaining pages
  const pagesToFetch = Math.min(totalPages, MAX_PAGES)
  for (let page = 1; page < pagesToFetch; page++) {
    try {
      const pageParams = new URLSearchParams({
        searchCriteria: JSON.stringify(searchCriteria),
        selectedSortOption: 'datedesc',
        page: String(page),
        pageSize: String(CSS_PAGE_SIZE),
      })
      const pageData = await cssCurlFetch(CSS_PATH, pageParams.toString(), token, headers)
      allListings.push(...parseCssListings(pageData, criteria))
    } catch {
      break
    }
  }

  const responseTimeMs = Date.now() - startTime
  const totalResults = data?.page?.totalElements || allListings.length
  console.log(`[Scraper-CSS] Search #${search.id}: ${allListings.length} listings fetched (${totalResults} total, ${pagesToFetch} pages, ${responseTimeMs}ms)`)

  return { listings: allListings, iterations: pagesToFetch, success: true, cost: 0, engine: 'css', responseTimeMs }
}
