import 'dotenv/config'
import { getPage, closeBrowser } from './browser.js'

const url = 'https://www.autotrader.co.uk/car-search?postcode=SW1A+1AA&make=Volkswagen&model=Golf&advertising-location=at_cars'

console.log('Testing scraper with URL:', url)
console.log('ANTHROPIC_API_KEY set:', !!process.env.ANTHROPIC_API_KEY)

try {
  const { html, cfSolved, cfCost, cfIterations } = await getPage(url)
  console.log('\n=== RESULT ===')
  console.log('HTML length:', html.length)
  console.log('CF solved:', cfSolved)
  console.log('CF cost: $' + cfCost.toFixed(4))
  console.log('CF iterations:', cfIterations)

  // Check if we got real content
  const hasListings = html.includes('advertCard')
  const hasResults = html.includes('search-listing')
  console.log('Has advert cards:', hasListings)
  console.log('Has search listings:', hasResults)

  // Extract page title
  const titleMatch = html.match(/<title>(.*?)<\/title>/i)
  console.log('Page title:', titleMatch?.[1] || 'unknown')

  // Try to count listings
  const cardMatches = html.match(/advertCard/g)
  console.log('Advert card references:', cardMatches?.length || 0)

} catch (err) {
  console.error('SCRAPER ERROR:', err.message)
} finally {
  await closeBrowser()
  process.exit(0)
}
