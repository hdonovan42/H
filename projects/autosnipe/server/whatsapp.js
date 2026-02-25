// WhatsApp bridge via moltbot gateway on same VPS
// Requires: hq user has SSH key access to moltbot@localhost
import { writeFileSync, unlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'

export async function sendWhatsApp(phone, message) {
  const tmpFile = `/tmp/autosnipe-msg-${Date.now()}.txt`

  try {
    writeFileSync(tmpFile, message, { mode: 0o644 })

    const cmd = `ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes moltbot@localhost 'cd ~/moltbot && node scripts/run-node.mjs agent --agent kimi --to "${phone}" --channel whatsapp --deliver --timeout 60 --message "$(cat ${tmpFile})"'`
    execSync(cmd, { timeout: 60000, encoding: 'utf-8' })
    console.log(`[WhatsApp] Sent to ${phone} (${message.length} chars)`)
    return { success: true }
  } catch (err) {
    console.error(`[WhatsApp] Failed: ${err.message}`)
    return { success: false, error: err.message }
  } finally {
    try { unlinkSync(tmpFile) } catch {}
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
