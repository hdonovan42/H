import jwt from 'jsonwebtoken'
import { randomUUID, randomBytes } from 'node:crypto'
import { Resend } from 'resend'
import { getDb } from './db.js'

const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex')
const RESEND_API_KEY = process.env.RESEND_API_KEY
const APP_URL = process.env.APP_URL || 'http://localhost:5177'

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null

export async function sendMagicLink(email) {
  const db = getDb()
  const token = randomBytes(32).toString('hex')
  const id = randomUUID()
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '')

  db.prepare(`
    INSERT INTO magic_links (id, email, token, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(id, email.toLowerCase().trim(), token, expiresAt)

  const link = `${APP_URL}/api/auth/verify?token=${token}`

  if (resend) {
    await resend.emails.send({
      from: 'AutoSnipe <noreply@autosnipe.co.uk>',
      to: email,
      subject: 'Your AutoSnipe login link',
      html: `
        <div style="font-family:'IBM Plex Mono',monospace;max-width:480px;margin:0 auto;padding:32px;background:#0a0a0f;color:#d0d0d8;">
          <h2 style="color:#FF6B00;margin-bottom:16px;">AutoSnipe</h2>
          <p>Click below to sign in. This link expires in 15 minutes.</p>
          <a href="${link}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#FF6B00;color:#fff;text-decoration:none;border-radius:4px;font-weight:600;">Sign In</a>
          <p style="color:#8888a0;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `
    })
  } else {
    // Dev mode: no email provider — return link in response for local testing
    console.log(`[Auth] Magic link for ${email}: ${link}`)
    return { success: true, dev_link: link }
  }

  return { success: true }
}

export function verifyMagicLink(token) {
  const db = getDb()

  const link = db.prepare(`
    SELECT * FROM magic_links
    WHERE token = ? AND used = 0 AND expires_at > datetime('now')
  `).get(token)

  if (!link) {
    // Check if it was already used vs truly expired/invalid
    const usedLink = db.prepare('SELECT * FROM magic_links WHERE token = ? AND used = 1').get(token)
    if (usedLink) return { success: false, error: 'already_used' }

    const expiredLink = db.prepare('SELECT * FROM magic_links WHERE token = ?').get(token)
    if (expiredLink) return { success: false, error: 'expired' }

    return { success: false, error: 'invalid' }
  }

  db.prepare('UPDATE magic_links SET used = 1 WHERE id = ?').run(link.id)

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(link.email)
  if (!user) {
    db.prepare('INSERT INTO users (email) VALUES (?)').run(link.email)
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(link.email)
  }

  const jwtToken = jwt.sign(
    { userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  )

  return { success: true, token: jwtToken, user }
}

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET)
    req.user = decoded
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid token' })
  }
}
