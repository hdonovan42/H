import puppeteer from 'puppeteer'

// ===== URL BUILDER =====

export function buildAutotraderUrl(criteria) {
  const params = new URLSearchParams()

  if (criteria.postcode) params.set('postcode', criteria.postcode)
  if (criteria.radius) params.set('radius', String(criteria.radius))
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

// ===== BROWSER SINGLETON =====

let browser = null

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,900'
      ]
    })
  }
  return browser
}

// ===== SCRAPER =====

export async function scrapeSearch(search) {
  const criteria = JSON.parse(search.criteria)
  const url = search.autotrader_url || buildAutotraderUrl(criteria)

  console.log(`[Scraper] Search #${search.id}: ${url}`)

  const b = await getBrowser()
  const page = await b.newPage()

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    )
    await page.setViewport({ width: 1280, height: 900 })

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })

    // Dismiss cookie banner if present
    try {
      const cookieBtn = await page.$('[data-testid="cookie-banner-accept"], #sp_message_iframe_953498')
      if (cookieBtn) {
        // If it's an iframe (OneTrust/SourcePoint), handle it
        const frames = page.frames()
        for (const frame of frames) {
          const acceptBtn = await frame.$('button[title="Accept All"], button[title="Accept"]')
          if (acceptBtn) {
            await acceptBtn.click()
            await new Promise(r => setTimeout(r, 1000))
            break
          }
        }
      }
    } catch {}

    // Wait for listing cards to render
    await page.waitForSelector('[data-testid*="advertCard"], article, .search-page__result', {
      timeout: 15000
    }).catch(() => {
      console.log('[Scraper] Timeout waiting for listing cards — page may have no results')
    })

    // Extra wait for dynamic content
    await new Promise(r => setTimeout(r, 2000))

    // Extract listings from the DOM
    const listings = await page.evaluate(() => {
      const results = []

      // Find all listing card elements
      const cards = document.querySelectorAll(
        '[data-testid*="advertCard"], article[data-standout-type], li[data-testid*="search-result"]'
      )

      cards.forEach(card => {
        try {
          // Title
          const titleEl = card.querySelector(
            '[data-testid="listing-title"], h3, [class*="listing-title"]'
          )
          const title = titleEl?.textContent?.trim() || ''

          // Price
          const priceEl = card.querySelector(
            '[data-testid="search-listing-price"], [class*="price"], span[class*="Price"]'
          )
          const priceText = priceEl?.textContent?.trim() || ''
          const price = parseInt(priceText.replace(/[^0-9]/g, '')) || null

          // Link to listing
          const linkEl = card.querySelector('a[href*="car-details"]')
          const href = linkEl?.getAttribute('href') || ''
          const fullUrl = href ? `https://www.autotrader.co.uk${href}` : ''

          // Extract advert ID from URL
          const idMatch = href.match(/car-details\/(\d+)/)
          const advertId = idMatch ? idMatch[1] : null

          // Subtitle / specs
          const subtitleEl = card.querySelector(
            '[data-testid="listing-subtitle"], [class*="subtitle"], p'
          )
          const subtitle = subtitleEl?.textContent?.trim() || ''

          // Image
          const imgEl = card.querySelector('img[src*="i.autotrader"], img[src*="cdn"]')
          const imageUrl = imgEl?.getAttribute('src') || ''

          // Location
          const locEl = card.querySelector(
            '[data-testid="listing-location"], [class*="location"], [class*="seller-location"]'
          )
          const location = locEl?.textContent?.trim() || ''

          // Seller type
          const sellerEl = card.querySelector('[data-testid*="seller"], [class*="seller-type"]')
          const sellerType = sellerEl?.textContent?.trim() || ''

          // Attention grabber (key specs like year, mileage, fuel, etc.)
          const grabberEl = card.querySelector(
            '[data-testid="listing-attention-grabber"], [class*="attention"], [class*="key-specs"]'
          )
          const grabber = grabberEl?.textContent?.trim() || ''

          // Parse specs from subtitle or grabber
          const specsText = subtitle + ' ' + grabber
          const yearMatch = specsText.match(/\b(19|20)\d{2}\b/)
          const mileageMatch = specsText.match(/([\d,]+)\s*miles/i)
          const fuelMatch = specsText.match(/\b(Petrol|Diesel|Electric|Hybrid|Plug-in Hybrid)\b/i)
          const transMatch = specsText.match(/\b(Automatic|Manual)\b/i)

          if (advertId && title) {
            results.push({
              autotrader_id: advertId,
              title,
              price,
              mileage: mileageMatch ? parseInt(mileageMatch[1].replace(/,/g, '')) : null,
              year: yearMatch ? parseInt(yearMatch[0]) : null,
              fuel_type: fuelMatch ? fuelMatch[1] : null,
              transmission: transMatch ? transMatch[1] : null,
              url: fullUrl,
              image_url: imageUrl,
              seller_type: sellerType || null,
              location: location || null
            })
          }
        } catch {}
      })

      return results
    })

    console.log(`[Scraper] Search #${search.id}: ${listings.length} listings extracted`)

    return { listings, iterations: 1, success: true }

  } catch (err) {
    console.error(`[Scraper] Search #${search.id} failed:`, err.message)
    return { listings: [], iterations: 1, success: false }
  } finally {
    await page.close()
  }
}

// Cleanup on process exit
process.on('exit', () => {
  if (browser) browser.close().catch(() => {})
})
