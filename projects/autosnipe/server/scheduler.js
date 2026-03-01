import { Cron } from 'croner'
import { getDb } from './db.js'
import { scrapeSearch, healthCheck } from './scraper.js'
import { cssSearch } from './scraper-css.js'
import { sendWhatsApp, formatListingAlert } from './whatsapp.js'
import { sendListingEmail } from './notify.js'
import { refreshTaxonomy, taxonomyNeedsRefresh } from './taxonomy.js'
import { alertHealthCheckFailed, trackZeroResults, alertScraperError, checkApkVersion } from './alerting.js'
import { POLL_INTERVAL_MINUTES, QUIET_START_UTC, QUIET_END_UTC } from '../shared/config.js'

let job = null
let quietJob = null
let taxonomyJob = null
let cleanupJob = null
let apkWatcherJob = null
let sssHealthy = true // assume healthy until proven otherwise

async function triggerPoll(label) {
  const db = getDb()

  // Atomic lock check via DB — better-sqlite3 is single-threaded so this is safe
  const lock = db.prepare("SELECT value FROM kv WHERE key = 'poll_running'").get()
  if (lock?.value === '1') {
    console.log('[Scheduler] Previous run still active, skipping')
    return
  }

  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('poll_running', '1')").run()
  console.log(`[Scheduler] Starting poll cycle (${label})`)

  try {
    await runPollCycle()
  } catch (err) {
    console.error('[Scheduler] Cycle error:', err.message)
  } finally {
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('poll_running', '0')").run()
  }
}

export function startScheduler() {
  // Main job: every N minutes, but skip during quiet hours
  job = new Cron(`*/${POLL_INTERVAL_MINUTES} * * * *`, async () => {
    const utcHour = new Date().getUTCHours()
    if (utcHour >= QUIET_START_UTC && utcHour < QUIET_END_UTC) return
    await triggerPoll('normal')
  })

  // Quiet hours: once per hour at :59 during 02:00–04:59 UTC
  quietJob = new Cron(`59 ${QUIET_START_UTC}-${QUIET_END_UTC - 1} * * *`, async () => {
    await triggerPoll('quiet')
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

  // Daily cleanup: purge poll_log entries older than 90 days + expired magic links
  cleanupJob = new Cron('0 3 * * *', { timezone: 'Europe/London' }, () => {
    const db = getDb()
    const deleted = db.prepare("DELETE FROM poll_log WHERE started_at < datetime('now', '-90 days')").run()
    if (deleted.changes > 0) console.log(`[Cleanup] Purged ${deleted.changes} poll_log entries >90 days`)

    const expiredLinks = db.prepare("DELETE FROM magic_links WHERE expires_at < datetime('now', '-1 day')").run()
    if (expiredLinks.changes > 0) console.log(`[Cleanup] Purged ${expiredLinks.changes} expired magic links`)

    const oldEvents = db.prepare("DELETE FROM stripe_events WHERE handled_at < datetime('now', '-90 days')").run()
    if (oldEvents.changes > 0) console.log(`[Cleanup] Purged ${oldEvents.changes} old stripe events`)
  })

  // APK version watcher — Wednesdays at noon London time
  apkWatcherJob = new Cron('0 12 * * 3', { timezone: 'Europe/London' }, async () => {
    console.log('[Scheduler] Running weekly APK version check')
    await checkApkVersion()
  })

  // Check APK on startup if stale (>7 days) or never checked
  const db = getDb()
  const lastChecked = db.prepare("SELECT value FROM kv WHERE key = 'apk_last_checked'").get()
  const stale = !lastChecked?.value || (Date.now() - new Date(lastChecked.value).getTime() > 7 * 24 * 60 * 60 * 1000)
  if (stale) {
    console.log('[Scheduler] APK version check stale or missing, running now...')
    checkApkVersion().catch(err =>
      console.error('[Scheduler] Startup APK check failed:', err.message)
    )
  }

  console.log(`[Scheduler] Active — every ${POLL_INTERVAL_MINUTES}m, quiet ${QUIET_START_UTC}:00–${QUIET_END_UTC}:00 UTC (hourly at :59), taxonomy Mon 06:00, cleanup daily 03:00, APK watcher Wed 12:00`)
}

// ===== FALLBACK SCRAPE =====
// Tries SSS first, falls back to CSS Core Search on failure.

async function scrapeWithFallback(search) {
  // Try SSS first
  try {
    const result = await scrapeSearch(search)
    return result
  } catch (sssErr) {
    console.warn(`[Fallback] SSS failed for search #${search.id}: ${sssErr.message} — trying CSS...`)

    // Try CSS fallback
    try {
      const result = await cssSearch(search)
      console.log(`[Fallback] CSS succeeded for search #${search.id}`)
      return result
    } catch (cssErr) {
      console.error(`[Fallback] Both SSS and CSS failed for search #${search.id}: SSS=${sssErr.message}, CSS=${cssErr.message}`)
      return { listings: [], iterations: 1, success: false, cost: 0, engine: 'none', responseTimeMs: 0 }
    }
  }
}

export async function pollSingleSearch(search, { skipNotify = false } = {}) {
  const db = getDb()

  const logId = db.prepare(`
    INSERT INTO poll_log (search_id) VALUES (?)
  `).run(search.id).lastInsertRowid

  try {
    const result = await scrapeWithFallback(search)

    // Find new listings (batch lookup instead of per-listing query)
    const existingIds = new Set(
      db.prepare('SELECT autotrader_id FROM listings WHERE search_id = ?')
        .all(search.id)
        .map(r => r.autotrader_id)
    )

    const newListings = []
    for (const listing of result.listings) {
      if (existingIds.has(listing.autotrader_id)) continue
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO listings (search_id, autotrader_id, title, price, mileage, year, fuel_type, transmission, url, image_url, seller_type, location)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        search.id, listing.autotrader_id, listing.title, listing.price,
        listing.mileage, listing.year, listing.fuel_type, listing.transmission,
        listing.url, listing.image_url, listing.seller_type, listing.location
      )
      if (inserted.changes > 0) newListings.push(listing)
    }

    // Update search
    db.prepare("UPDATE searches SET last_checked = datetime('now'), last_result_count = ? WHERE id = ?")
      .run(result.listings.length, search.id)

    // Track consecutive zero-result polls
    trackZeroResults(search.id, result.listings.length, search.last_result_count)

    // Notify on new listings (skip for silent polls like criteria edits)
    if (newListings.length > 0 && !skipNotify) {
      const searchName = search.name || `${JSON.parse(search.criteria).make || ''} ${JSON.parse(search.criteria).model || ''}`.trim()

      // Email (always)
      await sendListingEmail(search.email, newListings, searchName)

      // WhatsApp (if phone set)
      if (search.phone) {
        const message = formatListingAlert(newListings, searchName)
        await sendWhatsApp(search.phone, message)
      }

      // Mark as notified
      for (const listing of newListings) {
        db.prepare("UPDATE listings SET notified_at = datetime('now') WHERE search_id = ? AND autotrader_id = ?")
          .run(search.id, listing.autotrader_id)
      }
    }

    // Update poll log with metrics
    db.prepare(`
      UPDATE poll_log SET completed_at = datetime('now'), status = 'success',
      listings_found = ?, new_listings = ?, iterations = ?, cost_estimate = ?,
      response_time_ms = ?, scraper_engine = ?
      WHERE id = ?
    `).run(
      result.listings.length, newListings.length, result.iterations,
      result.cost || 0, result.responseTimeMs || null, result.engine || 'sss',
      logId
    )

    console.log(`[Poll] Search #${search.id}: ${result.listings.length} found, ${newListings.length} new (engine=${result.engine || 'sss'})`)

  } catch (err) {
    db.prepare(`
      UPDATE poll_log SET completed_at = datetime('now'), status = 'error', error = ?
      WHERE id = ?
    `).run(err.message, logId)
    alertScraperError(search.id, err.message)
    console.error(`[Poll] Search #${search.id} failed:`, err.message)
  }
}

export async function runPollCycle() {
  const db = getDb()

  // Canary health check before polling
  const health = await healthCheck()
  if (!health.healthy) {
    console.warn(`[Scheduler] SSS health check FAILED (status=${health.statusCode}, ${health.latencyMs}ms${health.error ? ', ' + health.error : ''}) — polls will use CSS fallback`)
    alertHealthCheckFailed(health)
    sssHealthy = false
  } else if (!sssHealthy) {
    console.log(`[Scheduler] SSS health check recovered (${health.latencyMs}ms)`)
    sssHealthy = true
  }

  const searches = db.prepare(`
    SELECT s.*, u.phone, u.email
    FROM searches s
    JOIN users u ON s.user_id = u.id
    WHERE s.active = 1
    ORDER BY s.last_checked ASC NULLS FIRST
  `).all()

  console.log(`[Scheduler] ${searches.length} active search(es) to poll`)

  for (const search of searches) {
    await pollSingleSearch(search)

    // Pause between searches
    await new Promise(r => setTimeout(r, 2000))
  }
}

export function stopScheduler() {
  if (job) {
    job.stop()
    console.log('[Scheduler] Poll job stopped')
  }
  if (quietJob) {
    quietJob.stop()
    console.log('[Scheduler] Quiet hours job stopped')
  }
  if (taxonomyJob) {
    taxonomyJob.stop()
    console.log('[Scheduler] Taxonomy job stopped')
  }
  if (cleanupJob) {
    cleanupJob.stop()
    console.log('[Scheduler] Cleanup job stopped')
  }
  if (apkWatcherJob) {
    apkWatcherJob.stop()
    console.log('[Scheduler] APK watcher job stopped')
  }
}
