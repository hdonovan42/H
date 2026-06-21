// WhatsApp bridge via moltbot gateway on same VPS
// Requires: hq user has SSH key access to moltbot@localhost
import { execSync } from 'node:child_process'

function escapeShell(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

export async function sendWhatsApp(phone, message) {
  // Alerting is OFF. The moltbot WhatsApp bridge was retired 2026-06-20 (VPS cleanup) and the
  // gateway no longer runs, so the SSH below would just block for the full 60s timeout — on the
  // event loop, since this is execSync — then fail. No-op until a new channel is chosen.
  // Set ALERTS_WHATSAPP=1 to re-enable the bridge path below (requires a live moltbot gateway).
  if (process.env.ALERTS_WHATSAPP !== '1') {
    return { success: false, disabled: true }
  }

  try {
    const safePhone = phone.replace(/[^0-9+]/g, '')
    const safeMessage = escapeShell(message)

    const cmd = `ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes moltbot@localhost 'cd ~/moltbot && node scripts/run-node.mjs agent --agent kimi --to "${safePhone}" --channel whatsapp --deliver --timeout 60 --message ${safeMessage}'`
    execSync(cmd, { timeout: 60000, encoding: 'utf-8' })
    console.log(`[WhatsApp] Sent to ${safePhone} (${message.length} chars)`)
    return { success: true }
  } catch (err) {
    console.error(`[WhatsApp] Failed: ${err.message}`)
    return { success: false, error: err.message }
  }
}

export function formatListingAlert(listings, searchName) {
  if (listings.length === 1) {
    const l = listings[0]
    return `AUTOSNIPE MATCH

${l.title}
${l.price ? `\u00a3${l.price.toLocaleString()}` : 'Price N/A'}
${l.mileage ? `${l.mileage.toLocaleString()} miles` : ''}${l.year ? ` | ${l.year}` : ''}${l.fuel_type ? ` | ${l.fuel_type}` : ''}${l.transmission ? ` | ${l.transmission}` : ''}
${l.seller_type ? `${l.seller_type}` : ''}${l.location ? ` | ${l.location}` : ''}

Search: ${searchName}
${l.url || 'No link available'}

autosnipe`
  }

  // Multiple listings — send summary
  const lines = listings.slice(0, 5).map(l =>
    `- ${l.title} | ${l.price ? `\u00a3${l.price.toLocaleString()}` : '?'} | ${l.mileage ? `${l.mileage.toLocaleString()}mi` : '?'}`
  )

  return `AUTOSNIPE: ${listings.length} NEW MATCH${listings.length > 1 ? 'ES' : ''}

Search: ${searchName}

${lines.join('\n')}
${listings.length > 5 ? `\n...and ${listings.length - 5} more` : ''}

View all: autosnipe`
}
