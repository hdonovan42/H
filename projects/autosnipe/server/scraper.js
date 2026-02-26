import * as cheerio from 'cheerio'
import { getPage } from './browser.js'

// ===== URL BUILDER =====

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

// ===== HTML PARSER =====

function parseListings(html) {
  const $ = cheerio.load(html)
  const results = []

  // Match real advert cards, exclude skeleton placeholders
  $('[data-testid*="advertCard"]').not('[data-testid*="skeleton"]').each((_, card) => {
    try {
      const $card = $(card)

      // Link to listing — extract advert ID
      const href = $card.find('a[href*="car-details"]').first().attr('href') || ''
      const idMatch = href.match(/car-details\/(\d+)/)
      const advertId = idMatch ? idMatch[1] : null
      if (!advertId) return

      // Title (format: "Make Model Spec, £price")
      const titleFull = $card.find('[data-testid="search-listing-title"]').first().text().trim()
      if (!titleFull) return

      // Extract price from end of title string
      const priceMatch = titleFull.match(/£([\d,]+)/)
      const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : null

      // Clean title — remove trailing ", £price"
      const title = titleFull.replace(/,?\s*£[\d,]+$/, '').trim()

      const fullUrl = `https://www.autotrader.co.uk${href.split('?')[0]}`

      // Subtitle / specs
      const subtitle = $card.find('[data-testid="search-listing-subtitle"]').first().text().trim()

      // Structured data fields
      const mileageText = $card.find('[data-testid="mileage"]').first().text().trim()
      const mileageMatch = mileageText.match(/([\d,]+)\s*miles/i)
      const mileage = mileageMatch ? parseInt(mileageMatch[1].replace(/,/g, '')) : null

      const yearText = $card.find('[data-testid="registered_year"]').first().text().trim()
      const yearMatch = yearText.match(/\b(19|20)\d{2}\b/)
      const year = yearMatch ? parseInt(yearMatch[0]) : null

      // Location — strip "Dealer location" prefix
      const locationRaw = $card.find('[data-testid="search-listing-location"]').first().text().trim()
      const location = locationRaw.replace(/^Dealer location/i, '').trim() || null

      // Image — try multiple src patterns (may be lazy-loaded)
      const imgEl = $card.find('img[src*="i.autotrader"], img[src*="cdn"], img[data-src]').first()
      const imageUrl = imgEl.attr('src') || imgEl.attr('data-src') || ''

      // Fuel type and transmission from subtitle
      const fuelMatch = subtitle.match(/\b(Petrol|Diesel|Electric|Hybrid|Plug-in Hybrid)\b/i)
      const transMatch = subtitle.match(/\b(Automatic|Manual|Auto)\b/i)
      const transmission = transMatch ? (transMatch[1] === 'Auto' ? 'Automatic' : transMatch[1]) : null

      results.push({
        autotrader_id: advertId,
        title,
        price,
        mileage,
        year,
        fuel_type: fuelMatch ? fuelMatch[1] : null,
        transmission,
        url: fullUrl,
        image_url: imageUrl || null,
        seller_type: null,
        location
      })
    } catch {}
  })

  return results
}

// ===== SCRAPER =====

export async function scrapeSearch(search) {
  const criteria = JSON.parse(search.criteria)
  const url = search.autotrader_url || buildAutotraderUrl(criteria)

  console.log(`[Scraper] Search #${search.id}: ${url}`)

  try {
    const { html, cfCost, cfIterations } = await getPage(url)
    const listings = parseListings(html)

    console.log(`[Scraper] Search #${search.id}: ${listings.length} listings extracted`)
    return { listings, iterations: cfIterations || 1, success: true, cost: cfCost || 0 }

  } catch (err) {
    console.error(`[Scraper] Search #${search.id} failed:`, err.message)
    return { listings: [], iterations: 1, success: false, cost: 0 }
  }
}
