import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { getDb } from './db.js'
import { sendMagicLink, verifyMagicLink, requireAuth } from './auth.js'
import { createSubscriptionCheckout, addSlot, createPortalSession, handleWebhook } from './stripe.js'
import { startScheduler, stopScheduler, runPollCycle, pollSingleSearch } from './scheduler.js'
import { buildAutotraderUrl, countSearch } from './scraper.js'
import { closeBrowser } from './browser.js'
import { getTaxonomy, refreshTaxonomy } from './taxonomy.js'
import { FREE_SEARCHES } from '../shared/config.js'

const app = express()
const PORT = process.env.PORT || 3103

// Stripe webhook needs raw body — must be before json parser
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const result = await handleWebhook(req.body, req.headers['stripe-signature'])
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.use(cors())
app.use(express.json())

// Request logging
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`)
  })
  next()
})

// ===== HEALTH =====

app.get('/api/health', (req, res) => {
  const db = getDb()
  res.json({
    ok: true,
    uptime: process.uptime(),
    activeSearches: db.prepare('SELECT COUNT(*) as n FROM searches WHERE active = 1').get().n,
    totalUsers: db.prepare('SELECT COUNT(*) as n FROM users').get().n
  })
})

// ===== AUTH =====

app.post('/api/auth/magic-link', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'Email required' })
  try {
    const result = await sendMagicLink(email)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/auth/verify', (req, res) => {
  const { token } = req.query
  if (!token) return res.status(400).json({ error: 'Token required' })

  const result = verifyMagicLink(token)
  if (result.success) {
    res.redirect(`/#/auth-callback?token=${result.token}`)
  } else {
    res.redirect(`/#/login?error=${result.error || 'invalid_link'}`)
  }
})

app.get('/api/auth/me', requireAuth, (req, res) => {
  const db = getDb()
  const user = db
    .prepare('SELECT id, email, phone, paid_slots, stripe_subscription_id, created_at FROM users WHERE id = ?')
    .get(req.user.userId)
  if (!user) return res.status(404).json({ error: 'User not found' })

  const activeCount = db.prepare('SELECT COUNT(*) as n FROM searches WHERE user_id = ? AND active = 1')
    .get(req.user.userId).n
  const maxSearches = FREE_SEARCHES + (user.paid_slots || 0)

  res.json({ ...user, active_searches: activeCount, max_searches: maxSearches, has_subscription: !!user.stripe_subscription_id })
})

// ===== SEARCHES =====

app.get('/api/searches', requireAuth, (req, res) => {
  const searches = getDb().prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM listings WHERE search_id = s.id) as total_listings,
      (SELECT COUNT(*) FROM listings WHERE search_id = s.id AND notified_at IS NOT NULL) as notified_count
    FROM searches s WHERE s.user_id = ? ORDER BY s.created_at DESC
  `).all(req.user.userId)
  res.json(searches)
})

app.post('/api/searches', requireAuth, (req, res) => {
  const db = getDb()
  const user = db.prepare('SELECT paid_slots FROM users WHERE id = ?').get(req.user.userId)
  const activeCount = db.prepare('SELECT COUNT(*) as n FROM searches WHERE user_id = ? AND active = 1')
    .get(req.user.userId).n

  const maxSearches = FREE_SEARCHES + (user.paid_slots || 0)
  if (activeCount >= maxSearches) {
    return res.status(403).json({
      error: `You have ${activeCount} active search${activeCount > 1 ? 'es' : ''}. Subscribe for more slots.`,
      buy_slot: true
    })
  }

  const { name, criteria } = req.body
  if (!criteria) return res.status(400).json({ error: 'Criteria required' })

  const autotraderUrl = buildAutotraderUrl(criteria)

  const result = db.prepare(`
    INSERT INTO searches (user_id, name, criteria, autotrader_url)
    VALUES (?, ?, ?, ?)
  `).run(req.user.userId, name || null, JSON.stringify(criteria), autotraderUrl)

  // Fire-and-forget: poll immediately so listings appear on dashboard
  const userInfo = db.prepare('SELECT email, phone FROM users WHERE id = ?').get(req.user.userId)
  const searchRow = db.prepare('SELECT * FROM searches WHERE id = ?').get(result.lastInsertRowid)
  Promise.resolve()
    .then(() => pollSingleSearch({ ...searchRow, email: userInfo.email, phone: userInfo.phone }))
    .catch(err => console.error(`[ImmediatePoll] Search #${result.lastInsertRowid} failed:`, err.message))

  res.json({ success: true, id: result.lastInsertRowid, autotraderUrl })
})

app.delete('/api/searches/:id', requireAuth, (req, res) => {
  const db = getDb()
  const search = db.prepare('SELECT * FROM searches WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.userId)
  if (!search) return res.status(404).json({ error: 'Search not found' })

  db.prepare('DELETE FROM listings WHERE search_id = ?').run(search.id)
  db.prepare('DELETE FROM poll_log WHERE search_id = ?').run(search.id)
  db.prepare('DELETE FROM searches WHERE id = ?').run(search.id)
  res.json({ success: true })
})

app.patch('/api/searches/:id', requireAuth, (req, res) => {
  const db = getDb()
  const search = db.prepare('SELECT * FROM searches WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.userId)
  if (!search) return res.status(404).json({ error: 'Search not found' })

  const { active, name, criteria } = req.body

  if (typeof active === 'boolean') {
    if (active && !search.active) {
      const user = db.prepare('SELECT paid_slots FROM users WHERE id = ?').get(req.user.userId)
      const activeCount = db.prepare('SELECT COUNT(*) as n FROM searches WHERE user_id = ? AND active = 1')
        .get(req.user.userId).n
      const maxSearches = FREE_SEARCHES + (user.paid_slots || 0)
      if (activeCount >= maxSearches) {
        return res.status(403).json({ error: 'No available search slots. Buy another slot to unpark this search.' })
      }
    }
    db.prepare('UPDATE searches SET active = ? WHERE id = ?').run(active ? 1 : 0, search.id)
  }

  if (name !== undefined) {
    db.prepare('UPDATE searches SET name = ? WHERE id = ?').run(name || null, search.id)
  }

  if (criteria) {
    const autotraderUrl = buildAutotraderUrl(criteria)
    db.prepare('UPDATE searches SET criteria = ?, autotrader_url = ?, last_checked = NULL WHERE id = ?')
      .run(JSON.stringify(criteria), autotraderUrl, search.id)

    // Purge old listings that may no longer match new criteria
    db.prepare('DELETE FROM listings WHERE search_id = ?').run(search.id)

    // Fire-and-forget: re-poll with new criteria
    const userInfo = db.prepare('SELECT email, phone FROM users WHERE id = ?').get(req.user.userId)
    const updatedSearch = db.prepare('SELECT * FROM searches WHERE id = ?').get(search.id)
    Promise.resolve()
      .then(() => pollSingleSearch({ ...updatedSearch, email: userInfo.email, phone: userInfo.phone }, { skipNotify: true }))
      .catch(err => console.error(`[ImmediatePoll] Search #${search.id} re-poll failed:`, err.message))
  }

  res.json({ success: true })
})

// ===== LISTINGS =====

app.get('/api/searches/:id/listings', requireAuth, (req, res) => {
  const db = getDb()
  const search = db.prepare('SELECT * FROM searches WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.userId)
  if (!search) return res.status(404).json({ error: 'Search not found' })

  const listings = db.prepare(`
    SELECT * FROM listings WHERE search_id = ? ORDER BY first_seen DESC LIMIT 100
  `).all(req.params.id)
  res.json(listings)
})

app.get('/api/matches/recent', requireAuth, (req, res) => {
  const listings = getDb().prepare(`
    SELECT l.*, s.name as search_name, s.criteria
    FROM listings l
    JOIN searches s ON l.search_id = s.id
    WHERE s.user_id = ?
    ORDER BY l.first_seen DESC
    LIMIT 50
  `).all(req.user.userId)
  res.json(listings)
})

// ===== SEARCH COUNT =====

app.post('/api/search-count', requireAuth, async (req, res) => {
  try {
    const { count, facets } = await countSearch(req.body)
    res.json({ count, facets })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ===== SETTINGS =====

app.patch('/api/settings', requireAuth, (req, res) => {
  const { phone } = req.body
  getDb().prepare('UPDATE users SET phone = ? WHERE id = ?')
    .run(phone || null, req.user.userId)
  res.json({ success: true })
})

// ===== STRIPE =====

app.post('/api/stripe/checkout', requireAuth, async (req, res) => {
  try {
    const db = getDb()
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId)

    if (user.stripe_subscription_id) {
      // Existing subscriber — bump quantity
      const result = await addSlot(req.user.userId)
      res.json({ added: true, paid_slots: result.paid_slots })
    } else {
      // New subscriber — redirect to Stripe Checkout
      const result = await createSubscriptionCheckout(req.user.userId, req.user.email)
      res.json({ url: result.url })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/stripe/portal', requireAuth, async (req, res) => {
  try {
    const db = getDb()
    const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?')
      .get(req.user.userId)

    if (!user?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found' })
    }

    const result = await createPortalSession(user.stripe_customer_id)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ===== TAXONOMY =====

app.get('/api/taxonomy', (req, res) => {
  const taxonomy = getTaxonomy()
  if (!taxonomy) return res.status(503).json({ error: 'Taxonomy not yet generated' })
  res.json(taxonomy)
})

// ===== ADMIN =====

function requireAdminAuth(req, res, next) {
  const token = req.headers['x-admin-token']
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorised' })
  }
  next()
}

app.post('/api/admin/refresh-taxonomy', requireAuth, async (req, res) => {
  try {
    await refreshTaxonomy()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/admin/poll', requireAuth, async (req, res) => {
  try {
    await runPollCycle()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Protected by X-Admin-Token header (+ nginx basic auth on dash.autosnipe.co.uk)
app.get('/api/admin/stats', requireAdminAuth, (req, res) => {
  const db = getDb()
  const users = db.prepare('SELECT COUNT(*) as total FROM users').get().total
  const searches = db.prepare('SELECT COUNT(*) as total FROM searches WHERE active = 1').get().total
  const listings = db.prepare('SELECT COUNT(*) as total FROM listings').get().total
  res.json({ users, activeSearches: searches, totalListings: listings })
})

app.get('/api/admin/users', requireAdminAuth, (req, res) => {
  const users = getDb().prepare(`
    SELECT id, email, phone, paid_slots, created_at FROM users ORDER BY created_at DESC
  `).all()
  res.json(users)
})

app.get('/api/admin/poll-log-all', requireAdminAuth, (req, res) => {
  const logs = getDb().prepare(`
    SELECT pl.*, s.name as search_name
    FROM poll_log pl
    JOIN searches s ON pl.search_id = s.id
    ORDER BY pl.started_at DESC
    LIMIT 50
  `).all()
  res.json(logs)
})

// ===== START =====

app.listen(PORT, () => {
  console.log(`AutoSnipe API running on port ${PORT}`)
  getDb()
  startScheduler()
  console.log('Ready.')
})

// ===== GRACEFUL SHUTDOWN =====

async function shutdown(signal) {
  console.log(`\n[Shutdown] ${signal} received, cleaning up...`)
  stopScheduler()

  // Wait for active poll to finish (up to 50s, leaving 10s for cleanup)
  const db = getDb()
  const deadline = Date.now() + 50000
  while (Date.now() < deadline) {
    const lock = db.prepare("SELECT value FROM kv WHERE key = 'poll_running'").get()
    if (!lock || lock.value !== '1') break
    console.log('[Shutdown] Waiting for active poll to finish...')
    await new Promise(r => setTimeout(r, 2000))
  }

  await closeBrowser()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
