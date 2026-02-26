import { Resend } from 'resend'

const RESEND_API_KEY = process.env.RESEND_API_KEY
const APP_URL = process.env.APP_URL || 'http://localhost:5177'
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null

const MAX_EMAIL_LISTINGS = 5

function listingRow(l) {
  const price = l.price ? `£${l.price.toLocaleString()}` : 'Price N/A'
  const details = [l.year, l.mileage ? `${l.mileage.toLocaleString()}mi` : null, l.fuel_type, l.transmission].filter(Boolean).join(' · ')
  const seller = [l.seller_type, l.location].filter(Boolean).join(' · ')
  const link = l.url || '#'

  return `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #1a1a24;">
        <a href="${link}" style="color:#FF6B00;text-decoration:none;font-weight:600;font-size:13px;">${l.title || 'Untitled'}</a>
        <div style="color:#e0e0e8;font-size:14px;font-weight:700;margin-top:2px;">${price}</div>
        <div style="color:#9090a8;font-size:11px;margin-top:2px;">${details}</div>
        ${seller ? `<div style="color:#9090a8;font-size:11px;">${seller}</div>` : ''}
      </td>
    </tr>`
}

export async function sendListingEmail(email, listings, searchName) {
  if (!resend) {
    console.log(`[Email] No Resend key — skipping email to ${email}`)
    return { success: false, error: 'No email provider' }
  }

  const count = listings.length
  const subject = count === 1
    ? `${listings[0].title || searchName} — ${listings[0].price ? '£' + listings[0].price.toLocaleString() : ''}`
    : `${count} new matches — ${searchName}`

  const shown = listings.slice(0, MAX_EMAIL_LISTINGS)
  const rows = shown.map(listingRow).join('')
  const overflow = count > MAX_EMAIL_LISTINGS
    ? `<p style="color:#9090a8;font-size:12px;margin-top:12px;">+ ${count - MAX_EMAIL_LISTINGS} more on your dashboard</p>`
    : ''

  const html = `
    <div style="font-family:'IBM Plex Mono',monospace;max-width:520px;margin:0 auto;padding:24px;background:#0a0a0f;color:#d0d0d8;">
      <h2 style="color:#FF6B00;margin:0 0 4px 0;font-size:15px;">AutoSnipe</h2>
      <p style="color:#9090a8;font-size:11px;margin:0 0 20px 0;">${searchName}</p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      ${overflow}
      <div style="margin-top:20px;">
        <a href="${APP_URL}/#/dashboard" style="color:#FF6B00;font-size:12px;text-decoration:none;">View dashboard →</a>
      </div>
    </div>`

  try {
    await resend.emails.send({
      from: 'AutoSnipe <noreply@autosnipe.co.uk>',
      to: email,
      subject,
      html
    })
    console.log(`[Email] Sent to ${email} (${count} listing${count > 1 ? 's' : ''})`)
    return { success: true }
  } catch (err) {
    console.error(`[Email] Failed to ${email}: ${err.message}`)
    return { success: false, error: err.message }
  }
}
