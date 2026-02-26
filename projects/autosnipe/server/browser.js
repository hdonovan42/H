import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { solveCloudflareTurnstile } from './cloudflare-solver.js'

puppeteer.use(StealthPlugin())

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable'
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--window-size=1280,800'
]

const PAGE_TIMEOUT = 45_000
const CF_DETECT_TIMEOUT = 5_000
const LISTING_WAIT_TIMEOUT = 30_000
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let browser = null

// ===== SINGLETON =====

export async function getBrowser() {
  if (browser && browser.connected) return browser

  console.log('[Browser] Launching Chrome...')
  browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME_PATH,
    args: LAUNCH_ARGS,
    defaultViewport: { width: 1280, height: 800 }
  })

  browser.on('disconnected', () => {
    console.log('[Browser] Chrome disconnected')
    browser = null
  })

  console.log('[Browser] Ready')
  return browser
}

export function isBrowserAlive() {
  return browser != null && browser.connected
}

export async function closeBrowser() {
  if (browser) {
    console.log('[Browser] Closing...')
    try {
      await browser.close()
    } catch {}
    browser = null
    console.log('[Browser] Closed')
  }
}

// ===== PAGE FETCHER =====

/**
 * Navigate to URL, handle Cloudflare if needed, return rendered HTML.
 * @param {string} url
 * @returns {{ html: string, cfSolved: boolean, cfCost: number, cfIterations: number }}
 */
export async function getPage(url) {
  const b = await getBrowser()
  const page = await b.newPage()
  await page.setUserAgent(USER_AGENT)
  let cfSolved = false
  let cfCost = 0
  let cfIterations = 0

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT })

    // Detect Cloudflare challenge
    const isCF = await detectCloudflare(page)

    if (isCF) {
      console.log('[Browser] Cloudflare detected, invoking solver...')
      const result = await solveCloudflareTurnstile(page)
      cfSolved = result.solved
      cfCost = result.cost
      cfIterations = result.iterations

      if (!result.solved) {
        console.log('[Browser] Cloudflare solve failed')
        const html = await page.content()
        return { html, cfSolved: false, cfCost, cfIterations }
      }

      // Wait for page to load after CF clear
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT }).catch(() => {})
    }

    // Handle postcode prompt — SPA sometimes requires form entry even with URL param
    await handlePostcodePrompt(page, url)

    // Wait for listing cards to render (SPA may need time for async API calls)
    try {
      await page.waitForSelector('[data-testid*="advertCard"]', { timeout: LISTING_WAIT_TIMEOUT })
      // Brief extra wait for all cards to hydrate
      await new Promise(r => setTimeout(r, 2000))
    } catch {
      // Cards didn't appear — try waiting a bit more for the SPA
      console.log('[Browser] No advert cards on first wait, waiting for network idle...')
      await page.waitForNetworkIdle({ idleTime: 2000, timeout: 10_000 }).catch(() => {})
      await new Promise(r => setTimeout(r, 3000))
    }

    const html = await page.content()
    console.log(`[Browser] Got ${html.length} bytes, CF solved: ${cfSolved}`)
    return { html, cfSolved, cfCost, cfIterations }

  } finally {
    await page.close().catch(() => {})
  }
}

// ===== POSTCODE HANDLING =====

async function handlePostcodePrompt(page, url) {
  // Check if page is showing "Please enter a postcode" prompt
  const postcodeInput = await page.$('[data-testid="input-postcode"]').catch(() => null)
  if (!postcodeInput) return

  // Extract postcode from URL
  const parsed = new URL(url)
  const postcode = parsed.searchParams.get('postcode')
  if (!postcode) return

  // Check if the input is visible and the results aren't already showing
  const hasCards = await page.$('[data-testid*="advertCard"]').catch(() => null)
  if (hasCards) return

  console.log(`[Browser] Postcode prompt detected, entering: ${postcode}`)
  await postcodeInput.click({ clickCount: 3 }) // Select all existing text
  await postcodeInput.type(postcode)
  await page.keyboard.press('Enter')

  // Wait for results to load after postcode submission
  await new Promise(r => setTimeout(r, 3000))
}

// ===== CLOUDFLARE DETECTION =====

async function detectCloudflare(page) {
  // Check page title
  const title = await page.title()
  if (title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('cloudflare')) {
    return true
  }

  // Check for Turnstile iframe
  try {
    const hasTurnstile = await page.waitForSelector(
      'iframe[src*="challenges.cloudflare.com"], #challenge-running, #challenge-stage',
      { timeout: CF_DETECT_TIMEOUT }
    )
    return !!hasTurnstile
  } catch {
    return false
  }
}
