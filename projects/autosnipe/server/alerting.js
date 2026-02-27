// ===== ADMIN ALERTING, SCHEMA VALIDATION & APK WATCHER =====
// Centralised alert dispatch with per-key cooldown.
// WhatsApp + email to admin when things break.

import { getDb } from './db.js'
import { sendWhatsApp } from './whatsapp.js'
import { Resend } from 'resend'
import gplay from 'google-play-scraper'

const ADMIN_PHONE = process.env.ADMIN_PHONE || '447742424242'
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'henry@hjd.ai'
const COOLDOWN_MS = 60 * 60 * 1000 // 1 hour per alert key

const RESEND_API_KEY = process.env.RESEND_API_KEY
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null

const AT_PACKAGE = 'uk.co.autotrader.androidconsumersearch'

// ===== CORE DISPATCH =====

export async function sendAdminAlert(alertKey, subject, body) {
  const db = getDb()
  const kvKey = `alert:${alertKey}`

  // Check cooldown
  const last = db.prepare('SELECT value FROM kv WHERE key = ?').get(kvKey)
  if (last?.value) {
    const elapsed = Date.now() - new Date(last.value).getTime()
    if (elapsed < COOLDOWN_MS) {
      console.log(`[Alert] Suppressed "${alertKey}" (cooldown ${Math.round((COOLDOWN_MS - elapsed) / 60000)}m remaining)`)
      return
    }
  }

  // Record this alert
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(kvKey, new Date().toISOString())

  console.log(`[Alert] Firing "${alertKey}": ${subject}`)

  // WhatsApp
  try {
    await sendWhatsApp(ADMIN_PHONE, `⚠️ AUTOSNIPE ALERT\n\n${subject}\n\n${body}`)
  } catch (err) {
    console.error(`[Alert] WhatsApp failed: ${err.message}`)
  }

  // Email
  if (resend) {
    try {
      await resend.emails.send({
        from: 'AutoSnipe Alerts <noreply@autosnipe.co.uk>',
        to: ADMIN_EMAIL,
        subject: `[AutoSnipe] ${subject}`,
        text: body
      })
    } catch (err) {
      console.error(`[Alert] Email failed: ${err.message}`)
    }
  }
}

// ===== HEALTH CHECK ALERT =====

export function alertHealthCheckFailed(health) {
  const detail = `Status: ${health.statusCode}, Latency: ${health.latencyMs}ms${health.error ? ', Error: ' + health.error : ''}`
  sendAdminAlert('health_check_failed', 'SSS health check failed', detail)
}

// ===== ZERO-RESULT TRACKING =====

export function trackZeroResults(searchId, resultCount, lastResultCount) {
  const db = getDb()
  const kvKey = `zero_streak:${searchId}`

  if (resultCount > 0) {
    // Reset streak on any non-zero result
    db.prepare('DELETE FROM kv WHERE key = ?').run(kvKey)
    return
  }

  // Only track if this search previously had results
  if (!lastResultCount || lastResultCount === 0) return

  // Increment streak
  const current = db.prepare('SELECT value FROM kv WHERE key = ?').get(kvKey)
  const streak = (parseInt(current?.value) || 0) + 1
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(kvKey, String(streak))

  if (streak >= 3) {
    sendAdminAlert(
      `zero_results_${searchId}`,
      `Search #${searchId} returned 0 results 3x in a row`,
      `Previously had ${lastResultCount} results. This may indicate an API format change or broken search criteria.`
    )
  }
}

// ===== SCRAPER ERROR ALERT =====

export function alertScraperError(searchId, errorMessage) {
  sendAdminAlert(
    `scraper_error_${searchId}`,
    `Scraper error on search #${searchId}`,
    errorMessage
  )
}

// ===== SSS RESPONSE SCHEMA VALIDATION =====

export function validateSssSchema(data) {
  try {
    if (!data?._embedded?.results) {
      sendAdminAlert('schema_drift', 'SSS schema drift: missing _embedded.results', `Response keys: ${Object.keys(data || {}).join(', ')}`)
      return false
    }

    const results = data._embedded.results
    if (results.length > 0 && !results[0].advertId) {
      sendAdminAlert('schema_drift', 'SSS schema drift: first result missing advertId', `First result keys: ${Object.keys(results[0]).join(', ')}`)
      return false
    }

    return true
  } catch (err) {
    console.error(`[Validate] Schema check error: ${err.message}`)
    return false
  }
}

// ===== APK VERSION WATCHER =====

export async function checkApkVersion() {
  try {
    const app = await gplay.app({ appId: AT_PACKAGE })
    const currentVersion = app.version

    const db = getDb()
    const stored = db.prepare("SELECT value FROM kv WHERE key = 'apk_last_version'").get()
    const lastVersion = stored?.value

    // Update last checked timestamp
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('apk_last_checked', ?)").run(new Date().toISOString())

    if (!lastVersion) {
      // First run — store version, no alert
      db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('apk_last_version', ?)").run(currentVersion)
      console.log(`[APK Watcher] Initial version recorded: ${currentVersion}`)
      return currentVersion
    }

    if (currentVersion !== lastVersion) {
      db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('apk_last_version', ?)").run(currentVersion)
      await sendAdminAlert(
        'apk_version_change',
        `Autotrader app updated: ${lastVersion} → ${currentVersion}`,
        `The Autotrader Android app has been updated on Google Play.\nOld: ${lastVersion}\nNew: ${currentVersion}\n\nCheck if CWS API auth or endpoints have changed.`
      )
      console.log(`[APK Watcher] Version change detected: ${lastVersion} → ${currentVersion}`)
    } else {
      console.log(`[APK Watcher] Version unchanged: ${currentVersion}`)
    }

    return currentVersion
  } catch (err) {
    console.error(`[APK Watcher] Failed to check Play Store: ${err.message}`)
    return null
  }
}
