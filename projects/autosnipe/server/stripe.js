import Stripe from 'stripe'
import { getDb } from './db.js'

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

const PRICE_ID = process.env.STRIPE_PRICE_ID
const APP_URL = process.env.APP_URL || 'http://localhost:5177'

export async function createCheckoutSession(userId, email) {
  if (!stripe) throw new Error('Stripe not configured')

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
    mode: 'subscription',
    line_items: [{ price: PRICE_ID, quantity: 1 }],
    success_url: `${APP_URL}/#/dashboard?upgraded=true`,
    cancel_url: `${APP_URL}/#/upgrade`
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

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object
      db.prepare('UPDATE users SET tier = ? WHERE stripe_customer_id = ?')
        .run('pro', session.customer)
      console.log(`[Stripe] User upgraded to pro: ${session.customer}`)
      break
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object
      db.prepare('UPDATE users SET tier = ? WHERE stripe_customer_id = ?')
        .run('free', sub.customer)
      console.log(`[Stripe] Subscription cancelled: ${sub.customer}`)
      break
    }
  }

  return { received: true }
}
