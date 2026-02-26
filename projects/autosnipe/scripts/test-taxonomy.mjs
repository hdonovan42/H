import 'dotenv/config'
import { getPage, getBrowser, closeBrowser } from './browser.js'

// Step 1: Solve CF
console.log('Step 1: Establishing CF-cleared session...')
await getPage('https://www.autotrader.co.uk/car-search?postcode=SW1A+1AA&advertising-location=at_cars')

async function getFacets(make, model) {
  const browser = await getBrowser()
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

  let facetsBody = null
  page.on('response', async (resp) => {
    if (resp.url().includes('FacetsWithGroups')) {
      try { facetsBody = await resp.text() } catch {}
    }
  })

  let url = `https://www.autotrader.co.uk/car-search?postcode=SW1A+1AA&advertising-location=at_cars&make=${encodeURIComponent(make)}`
  if (model) url += `&model=${encodeURIComponent(model)}`

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
  await new Promise(r => setTimeout(r, 5000))
  await page.close()

  if (!facetsBody) return null
  const parsed = JSON.parse(facetsBody)
  const facetsEntry = Array.isArray(parsed) ? parsed[1] || parsed[0] : parsed
  return facetsEntry?.data?.searchResults?.facets || []
}

// Get VW facets
console.log('\n--- Volkswagen Models ---')
const vwFacets = await getFacets('Volkswagen')
const modelFacet = vwFacets.find(f => f.facet === 'model')
const trimFacet = vwFacets.find(f => f.facet === 'aggregated_trim')

console.log('\nModels:')
const modelOptions = modelFacet?.filters?.[0]?.options || []
modelOptions.forEach(o => console.log(`  ${o.label} (${o.count})`))

console.log('\nTrims (without model selected):')
const trimOptions = trimFacet?.filters?.[0]?.options || []
trimOptions.forEach(o => console.log(`  ${o.label} (${o.count})`))

// Now get Golf-specific trims
console.log('\n--- Golf Trims ---')
const golfFacets = await getFacets('Volkswagen', 'Golf')
const golfTrimFacet = golfFacets.find(f => f.facet === 'aggregated_trim')
const golfTrims = golfTrimFacet?.filters?.[0]?.options || []
console.log(`\nGolf aggregated_trim options (${golfTrims.length}):`)
golfTrims.forEach(o => console.log(`  ${o.label} → value="${o.value}" (${o.count})`))

await closeBrowser()
process.exit(0)
