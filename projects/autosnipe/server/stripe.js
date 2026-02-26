import Stripe from 'stripe'
import { getDb } from './db.js'
import { SLOT_PRICE, SUPPORTED_CURRENCIES } from '../shared/config.js'

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

const APP_URL = process.env.APP_URL || 'http://localhost:5177'

export async function createSlotCheckout(userId, email, currency) {
  if (!stripe) throw new Error('Stripe not configured')
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new Error(`Unsupported currency. Use: ${SUPPORTED_CURRENCIES.join(', ')}`)
  }

  const db = getDb()
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)

  let customerId = user.stripe_customer_id
  if (!customerId) {
    const customer = await stripe.customers.create({ email })
    customerId = customer.id
    db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?')
      .run(customerId, userId)
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'payment',
    line_items: [{
      price_data: {
        currency,
        unit_amount: SLOT_PRICE * 100,
        product_data: {
          name: 'AutoSnipe — Extra Search Slot',
          description: 'One additional concurrent search'
        }
      },
      quantity: 1
    }],
    metadata: { user_id: String(userId) },
    success_url: `${APP_URL}/#/dashboard?purchased=true`,
    cancel_url: `${APP_URL}/#/buy-slot`
  })

  return { url: session.url }
}

export async function handleWebhook(rawBody, signature) {
  if (!stripe) throw new Error('Stripe not configured')

  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  )

  const db = getDb()

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const userId = session.metadata?.user_id

    if (!userId) {
      console.warn('[Stripe] checkout.session.completed without user_id metadata')
      return { received: true }
    }

    // Record purchase and increment slots
    const existing = db.prepare('SELECT id FROM purchases WHERE stripe_session_id = ?')
      .get(session.id)

    if (!existing) {
      db.prepare(`
        INSERT INTO purchases (user_id, stripe_session_id, currency, amount)
        VALUES (?, ?, ?, ?)
      `).run(userId, session.id, session.currency, session.amount_total)

      db.prepare('UPDATE users SET paid_slots = paid_slots + 1 WHERE id = ?')
        .run(userId)

      console.log(`[Stripe] Slot purchased for user ${userId} (${session.currency} ${session.amount_total})`)
    }
  }

  return { received: true }
}
