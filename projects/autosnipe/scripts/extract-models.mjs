import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { solveCloudflareTurnstile } from './cloudflare-solver.js'

puppeteer.use(StealthPlugin())

const b = await puppeteer.launch({
  headless: false,
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1280, height: 800 }
})

const page = await b.newPage()
await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

await page.goto('https://www.autotrader.co.uk/car-search?make=Volkswagen&model=Golf&postcode=SW1A+1AA', {
  waitUntil: 'networkidle2',
  timeout: 60000
})

// Check for Cloudflare
const title = await page.title()
console.log('PAGE_TITLE:', title)

if (title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('cloudflare')) {
  console.log('Cloudflare detected, solving...')
  const result = await solveCloudflareTurnstile(page)
  console.log('CF result:', JSON.stringify(result))
  if (result.solved) {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {})
  }
}

// Wait for SPA to render
await new Promise(r => setTimeout(r, 8000))

const title2 = await page.title()
console.log('TITLE_AFTER:', title2)
console.log('URL:', page.url())

// Dump first 3000 chars of body text to see what rendered
const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 3000) || 'NO BODY')
console.log('BODY_TEXT:', bodyText)

// Also intercept network requests for taxonomy/facet API calls
// Let's try navigating to the main search page and watching network requests for model data
const page2 = await b.newPage()
await page2.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

// Intercept XHR/fetch requests
const apiCalls = []
page2.on('response', async (response) => {
  const url = response.url()
  if (url.includes('gateway') || url.includes('facet') || url.includes('taxonomy') || url.includes('model') || url.includes('graphql')) {
    try {
      const body = await response.text()
      apiCalls.push({ url: url.substring(0, 200), status: response.status(), bodySnippet: body.substring(0, 500) })
    } catch {}
  }
})

await page2.goto('https://www.autotrader.co.uk/', { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise(r => setTimeout(r, 5000))

console.log('\nAPI_CALLS:', JSON.stringify(apiCalls, null, 2))

await b.close()
