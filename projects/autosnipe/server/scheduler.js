import { Cron } from 'croner'
import { getDb } from './db.js'
import { scrapeSearch } from './scraper.js'
import { sendWhatsApp, formatListingAlert } from './whatsapp.js'
import { refreshTaxonomy, taxonomyNeedsRefresh } from './taxonomy.js'
import { POLL_INTERVAL_MINUTES, NIGHT_SKIP_START, NIGHT_SKIP_END } from '../shared/config.js'

let job = null
let taxonomyJob = null
let isRunning = false

export function startScheduler() {
  job = new Cron(`*/${POLL_INTERVAL_MINUTES} * * * *`, async () => {
    if (isRunning) {
      console.log('[Scheduler] Previous run still active, skipping')
      return
    }
    isRunning = true
    console.log('[Scheduler] Starting poll cycle')

    try {
      await runPollCycle()
    } catch (err) {
      console.error('[Scheduler] Cycle error:', err.message)
    } finally {
      isRunning = false
    }
  })

  // Taxonomy refresh — every Monday at 06:00 London time
  taxonomyJob = new Cron('0 6 * * 1', { timezone: 'Europe/London' }, async () => {
    console.log('[Scheduler] Starting weekly taxonomy refresh')
    try {
      await refreshTaxonomy()
      console.log('[Scheduler] Taxonomy refresh complete')
    } catch (err) {
      console.error('[Scheduler] Taxonomy refresh failed:', err.message)
    }
  })

  // Refresh taxonomy on startup if stale or missing
  if (taxonomyNeedsRefresh()) {
    console.log('[Scheduler] Taxonomy stale or missing, refreshing in background...')
    refreshTaxonomy().catch(err =>
      console.error('[Scheduler] Startup taxonomy refresh failed:', err.message)
    )
  }

  console.log(`[Scheduler] Active — polling every ${POLL_INTERVAL_MINUTES}m, taxonomy every Monday 06:00`)
}

export async function runPollCycle() {
  // Skip overnight polls — few listings posted, saves ~25% of API spend
  const londonHour = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false })
  const hour = parseInt(londonHour, 10)
  if (hour >= NIGHT_SKIP_START && hour < NIGHT_SKIP_END) {
    console.log(`[Scheduler] Night skip — ${hour}:00 London time (window: ${NIGHT_SKIP_START}:00–${NIGHT_SKIP_END}:00)`)
    return
  }

  const db = getDb()

  const searches = db.prepare(`
    SELECT s.*, u.phone, u.email
    FROM searches s
    JOIN users u ON s.user_id = u.id
    WHERE s.active = 1
    ORDER BY s.last_checked ASC NULLS FIRST
  `).all()

  console.log(`[Scheduler] ${searches.length} active search(es) to poll`)

  for (const search of searches) {
    const logId = db.prepare(`
      INSERT INTO poll_log (search_id) VALUES (?)
    `).run(search.id).lastInsertRowid

    try {
      const result = await scrapeSearch(search)

      // Find new listings
      const newListings = []
      for (const listing of result.listings) {
        const existing = db.prepare(
          'SELECT id FROM listings WHERE search_id = ? AND autotrader_id = ?'
        ).get(search.id, listing.autotrader_id)

        if (!existing) {
          db.prepare(`
            INSERT INTO listings (search_id, autotrader_id, title, price, mileage, year, fuel_type, transmission, url, image_url, seller_type, location)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            search.id, listing.autotrader_id, listing.title, listing.price,
            listing.mileage, listing.year, listing.fuel_type, listing.transmission,
            listing.url, listing.image_url, listing.seller_type, listing.location
          )
          newListings.push(listing)
        }
      }

      // Update search
      db.prepare("UPDATE searches SET last_checked = datetime('now'), last_result_count = ? WHERE id = ?")
        .run(result.listings.length, search.id)

      // WhatsApp for new listings
      if (newListings.length > 0 && search.phone) {
        const searchName = search.name || `${JSON.parse(search.criteria).make || ''} ${JSON.parse(search.criteria).model || ''}`.trim()
        const message = formatListingAlert(newListings, searchName)
        await sendWhatsApp(search.phone, message)

        // Mark as notified
        for (const listing of newListings) {
          db.prepare("UPDATE listings SET notified_at = datetime('now') WHERE search_id = ? AND autotrader_id = ?")
            .run(search.id, listing.autotrader_id)
        }
      }

      // Update poll log
      db.prepare(`
        UPDATE poll_log SET completed_at = datetime('now'), status = 'success',
        listings_found = ?, new_listings = ?, iterations = ?, cost_estimate = ?
        WHERE id = ?
      `).run(result.listings.length, newListings.length, result.iterations, result.cost || 0, logId)

      console.log(`[Scheduler] Search #${search.id}: ${result.listings.length} found, ${newListings.length} new`)

    } catch (err) {
      db.prepare("UPDATE poll_log SET completed_at = datetime('now'), status = 'error', error = ? WHERE id = ?")
        .run(err.message, logId)
      console.error(`[Scheduler] Search #${search.id} failed:`, err.message)
    }

    // Pause between searches
    await new Promise(r => setTimeout(r, 2000))
  }
}

export function stopScheduler() {
  if (job) {
    job.stop()
    console.log('[Scheduler] Poll job stopped')
  }
  if (taxonomyJob) {
    taxonomyJob.stop()
    console.log('[Scheduler] Taxonomy job stopped')
  }
}
