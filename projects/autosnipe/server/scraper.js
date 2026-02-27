// ===== AUTOTRADER CWS API SCRAPER =====
// Uses the mobile app's internal API (reverse-engineered from APK).
// No browser, no Cloudflare, zero cost per request.

import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(__dirname, 'data')
const DEVICE_ID_PATH = resolve(DATA_DIR, '.device-id')

export const CWS_BASE = 'https://cws.autotrader.co.uk/CoordinatedWebService/application/crs'
const CWS_USERNAME = 'consumerandroid'
const CWS_PASSWORD = '0diordnaremusnoc2'
let appVersion = '7.48'
export const COMPOSABLE_VERSION = 'v1_17'
const PAGE_SIZE = 20
const MAX_PAGES = 5 // Cap at 100 listings per search to stay polite

// ===== PERSISTENT DEVICE ID =====

let deviceId

function getDeviceId() {
  if (deviceId) return deviceId
  try {
    deviceId = readFileSync(DEVICE_ID_PATH, 'utf8').trim()
    if (deviceId) return deviceId
  } catch { /* file doesn't exist yet */ }
  deviceId = randomUUID()
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(DEVICE_ID_PATH, deviceId)
  console.log(`[Scraper] Generated new deviceId: ${deviceId}`)
  return deviceId
}

// ===== ACCESS TOKEN CACHE =====

let cachedToken = null
let tokenExpiry = 0
let tokenRefreshPromise = null
let sessionId = null // persisted per token lifetime
const TOKEN_TTL = 22 * 60 * 60 * 1000 // 22h (server allows 24h, extra buffer)
const TOKEN_BUFFER = 60 * 60 * 1000    // Refresh if <1h remaining

export async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - TOKEN_BUFFER) return cachedToken
  if (tokenRefreshPromise) return tokenRefreshPromise

  tokenRefreshPromise = (async () => {
    try {
      sessionId = randomUUID() // new session per token lifetime
      const did = getDeviceId()

      const res = await fetch(
        `${CWS_BASE}/connect/${CWS_USERNAME}/${CWS_PASSWORD}?version=${appVersion}`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': `Consumer_Android/v${appVersion}`,
            'Accept-Encoding': 'gzip',
            'Content-Type': 'application/json',
            'sessionId': sessionId,
            'deviceId': did,
            'platform': 'android',
            'platform-version': appVersion,
            'platform-os-version': '14',
            'channel': 'Cars'
          }
        }
      )

      if (!res.ok) {
        // Version probing: try incrementing if auth fails
        const probed = await probeVersion(res.status)
        if (probed) return probed
        throw new Error(`CWS connect failed: HTTP ${res.status}`)
      }

      const token = await res.text()
      if (!token || token.length < 50) throw new Error('CWS connect returned invalid token')

      cachedToken = token
      tokenExpiry = Date.now() + TOKEN_TTL
      console.log(`[Scraper] CWS access token acquired (${token.length} chars, v${appVersion}, expires in 22h)`)
      return token
    } finally {
      tokenRefreshPromise = null
    }
  })()

  return tokenRefreshPromise
}

// ===== VERSION PROBING =====

async function probeVersion(originalStatus) {
  const baseMinor = 48
  const maxMinor = 60
  const baseMajor = 7

  console.log(`[Scraper] Auth failed (HTTP ${originalStatus}), probing versions ${baseMajor}.${baseMinor + 1}–${baseMajor}.${maxMinor}...`)

  for (let minor = baseMinor + 1; minor <= maxMinor; minor++) {
    const testVersion = `${baseMajor}.${minor}`
    try {
      const did = getDeviceId()
      const sid = randomUUID()
      const res = await fetch(
        `${CWS_BASE}/connect/${CWS_USERNAME}/${CWS_PASSWORD}?version=${testVersion}`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': `Consumer_Android/v${testVersion}`,
            'Accept-Encoding': 'gzip',
            'Content-Type': 'application/json',
            'sessionId': sid,
            'deviceId': did,
            'platform': 'android',
            'platform-version': testVersion,
            'platform-os-version': '14',
            'channel': 'Cars'
          }
        }
      )

      if (res.ok) {
        const token = await res.text()
        if (token && token.length >= 50) {
          appVersion = testVersion
          sessionId = sid
          cachedToken = token
          tokenExpiry = Date.now() + TOKEN_TTL
          console.log(`[Scraper] Version probe SUCCESS: v${testVersion} works! (was v7.48)`)
          return token
        }
      }
    } catch { /* probe failed, try next */ }
  }

  console.error('[Scraper] Version probe exhausted (7.49–7.60), no working version found')
  return null
}

// ===== URL BUILDER (kept for autotrader_url column in DB) =====

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
  if (criteria.body_type) params.set('body-type', criteria.body_type)
  if (criteria.doors) params.set('quantity-of-doors', criteria.doors)
  if (criteria.colour) params.set('colour', criteria.colour)
  if (criteria.variant) params.set('aggregatedTrim', criteria.variant)
  if (criteria.exclude_cat) params.set('exclude-writeoff-categories', 'on')

  params.set('sort', 'relevance')
  params.set('advertising-location', 'at_cars')

  return `https://www.autotrader.co.uk/car-search?${params.toString()}`
}

// ===== CWS QUERY BUILDER =====

export function buildSearchParams(criteria, { page = 1, size = PAGE_SIZE } = {}) {
  const params = new URLSearchParams()

  params.set('advertising_location', 'at_cars')
  params.set('postcode', String(criteria.postcode || 'SW1A 1AA').replace(/\s/g, ''))
  if (criteria.radius) params.set('distance', String(criteria.radius))
  if (criteria.make) params.set('make', criteria.make)
  if (criteria.model) params.set('model', criteria.model)
  if (criteria.variant) params.set('aggregated_trim', criteria.variant)
  if (criteria.year_from) params.set('min_year_manufactured', String(criteria.year_from))
  if (criteria.year_to) params.set('max_year_manufactured', String(criteria.year_to))
  if (criteria.price_from) params.set('min_price', String(criteria.price_from))
  if (criteria.price_to) params.set('max_price', String(criteria.price_to))
  if (criteria.mileage_max) params.set('max_mileage', String(criteria.mileage_max))
  if (criteria.fuel_type) params.set('fuel_type', criteria.fuel_type)
  if (criteria.transmission) params.set('transmission', criteria.transmission)
  if (criteria.body_type) params.set('raw_body_type', criteria.body_type)
  if (criteria.doors) params.set('doors_values', criteria.doors)
  if (criteria.colour) params.set('colour', criteria.colour)
  if (criteria.exclude_cat) params.set('is_writeoff', 'false')

  params.set('sort', 'datedesc')
  params.set('size', String(size))
  params.set('page', String(page))

  return params
}

// ===== RESPONSE PARSER =====
// The CWS API does NOT return fuel type or transmission as structured fields.
// Primary source: the search criteria (AT's own filter guarantees every result matches).
// Fallback: best-effort parse from the derivative string (dealer-supplied text).

export function parseListings(data, criteria = {}) {
  const results = []
  const adverts = data?._embedded?.results || []

  for (const listing of adverts) {
    if (!listing.advertId) continue

    const spec = listing.specification || {}
    const vehicle = listing.vehicle || {}
    const sale = listing.sale || {}
    const pricing = sale.pricing || {}
    const advertiser = listing.advertiser || {}
    const advLocation = advertiser.location || {}
    const mileageInfo = vehicle.mileage || {}
    const media = listing.media || {}
    const images = media.images || []

    // Title: use sale.title (full derivative) falling back to make+model
    const title = sale.title || `${spec.make || ''} ${spec.model || ''}`.trim()

    // Price
    const price = pricing.totalPrice || pricing.price || null

    // Mileage
    const mileage = typeof mileageInfo.mileage === 'number' ? mileageInfo.mileage : null

    // Fuel type: criteria is authoritative (AT filtered on it), derivative is fallback
    let fuelType = criteria.fuel_type || null
    if (!fuelType) {
      const derivative = spec.suppliedDerivative || spec.derivative || ''
      const fuelMatch = derivative.match(/\b(Petrol|Diesel|Electric|Hybrid|Plug-in Hybrid)\b/i)
      fuelType = fuelMatch ? fuelMatch[1] : null
    }

    // Transmission: same logic — criteria first, derivative fallback
    let transmission = criteria.transmission || null
    if (!transmission) {
      const derivative = spec.suppliedDerivative || spec.derivative || ''
      const transMatch = derivative.match(/\b(Automatic|Manual|Auto|Steptronic|DCT|PDK|DSG|CVT|Tiptronic)\b/i)
      if (transMatch) {
        transmission = (transMatch[1] === 'Manual') ? 'Manual' : 'Automatic'
      }
    }

    // Image URL (templated: replace {resize} with size)
    let imageUrl = null
    if (images.length > 0) {
      const href = images[0]?._links?.self?.href
      if (href) imageUrl = href.replace('{resize}', '800x600')
    }

    // Location
    const town = advLocation.town || ''
    const region = advLocation.region || ''
    const location = town || region || null

    results.push({
      autotrader_id: listing.advertId,
      title,
      price,
      mileage,
      year: vehicle.manufacturedYear || null,
      fuel_type: fuelType,
      transmission,
      url: listing.autotraderWebsiteLink || `https://www.autotrader.co.uk/car-details/${listing.advertId}`,
      image_url: imageUrl,
      seller_type: advertiser.type || null,
      location
    })
  }

  return results
}

// ===== SHARED FETCH HELPER =====

export function buildHeaders(token) {
  return {
    'Accept': 'application/json',
    'User-Agent': `Consumer_Android/v${appVersion}`,
    'Accept-Encoding': 'gzip',
    'Content-Type': 'application/json',
    'Access-Token': token,
    'channel': 'Cars',
    'sessionId': sessionId || randomUUID(),
    'deviceId': getDeviceId(),
    'platform': 'android',
    'platform-version': appVersion,
    'platform-os-version': '14',
    'composableVersion': COMPOSABLE_VERSION,
    'sss-version': '1',
    'X-Request-Options': 'PI_V3,EXCLUDE_TECH_SPEC,DISCLAIMERS,COMPOSABLE_V1_3,FPA_CONSOLIDATION'
  }
}

export async function cwsFetch(url) {
  const token = await getAccessToken()
  const res = await fetch(url, { headers: buildHeaders(token) })

  if (!res.ok) {
    // Retry once on auth failure with a fresh token (safe — getAccessToken deduplicates)
    if ((res.status === 401 || res.status === 403) && cachedToken) {
      console.log(`[Scraper] Token rejected (${res.status}), invalidating and refreshing...`)
      cachedToken = null
      tokenExpiry = 0
      tokenRefreshPromise = null // clear any in-flight refresh with the old token
      const freshToken = await getAccessToken()
      const retry = await fetch(url, { headers: buildHeaders(freshToken) })
      if (!retry.ok) throw new Error(`CWS API returned ${retry.status} after token refresh`)
      return retry.json()
    }
    throw new Error(`CWS API returned ${res.status}`)
  }

  return res.json()
}

// ===== HEALTH CHECK =====

export async function healthCheck() {
  const start = Date.now()
  try {
    const params = buildSearchParams(
      { make: 'BMW', postcode: 'SW1A1AA', price_from: 5000, price_to: 50000 },
      { size: 1 }
    )
    const url = `${CWS_BASE}/sss/searchone/adverts?${params.toString()}`
    const token = await getAccessToken()
    const res = await fetch(url, { headers: buildHeaders(token) })
    const latencyMs = Date.now() - start

    if (!res.ok) {
      return { healthy: false, latencyMs, statusCode: res.status }
    }

    const data = await res.json()
    const hasResults = !!data?._embedded?.results?.[0]?.advertId

    return { healthy: hasResults, latencyMs, statusCode: res.status }
  } catch (err) {
    return { healthy: false, latencyMs: Date.now() - start, statusCode: 0, error: err.message }
  }
}

// ===== COUNT (lightweight — size=0, no listings parsed) =====

export async function countSearch(criteria) {
  const params = buildSearchParams(criteria, { size: 0 })
  // Request facets for dynamic dropdowns
  for (const f of ['raw_body_type', 'fuel_type', 'transmission', 'colour', 'doors_values']) {
    params.append('facet', f)
  }
  const url = `${CWS_BASE}/sss/searchone/adverts?${params.toString()}`
  const data = await cwsFetch(url)
  const count = data?.page?.totalElements ?? 0
  const rawFacets = data?.facets || {}
  return {
    count,
    facets: {
      body_type: rawFacets.raw_body_type || [],
      fuel_type: rawFacets.fuel_type || [],
      transmission: rawFacets.transmission || [],
      colour: rawFacets.colour || [],
      doors: rawFacets.doors_values || [],
    }
  }
}

// ===== SCRAPER =====

export async function scrapeSearch(search) {
  const criteria = JSON.parse(search.criteria)

  console.log(`[Scraper] Search #${search.id}: querying CWS SSS API`)

  const startTime = Date.now()

  try {
    // Fetch page 1
    const params = buildSearchParams(criteria, { page: 1 })
    const url = `${CWS_BASE}/sss/searchone/adverts?${params.toString()}`
    const data = await cwsFetch(url)

    const totalResults = data?.page?.totalElements || 0
    const totalPages = data?.page?.totalPages || 1
    const allListings = parseListings(data, criteria)

    // Fetch remaining pages up to MAX_PAGES
    const pagesToFetch = Math.min(totalPages, MAX_PAGES)
    for (let page = 2; page <= pagesToFetch; page++) {
      const pageParams = buildSearchParams(criteria, { page })
      const pageUrl = `${CWS_BASE}/sss/searchone/adverts?${pageParams.toString()}`
      const pageData = await cwsFetch(pageUrl)
      allListings.push(...parseListings(pageData, criteria))
    }

    const responseTimeMs = Date.now() - startTime
    console.log(`[Scraper] Search #${search.id}: ${allListings.length} listings fetched (${totalResults} total, ${pagesToFetch} pages, ${responseTimeMs}ms)`)
    return { listings: allListings, iterations: pagesToFetch, success: true, cost: 0, engine: 'sss', responseTimeMs }

  } catch (err) {
    const responseTimeMs = Date.now() - startTime
    console.error(`[Scraper] Search #${search.id} SSS failed (${responseTimeMs}ms):`, err.message)
    throw err // let caller handle fallback
  }
}
