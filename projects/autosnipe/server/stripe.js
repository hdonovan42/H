import Stripe from 'stripe'
import { getDb } from './db.js'
import { SLOT_PRICE, FREE_SEARCHES, CURRENCY } from '../shared/config.js'

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

const APP_URL = process.env.APP_URL || 'http://localhost:5177'

// ===== CHECKOUT (first paid slot) =====

export async function createSubscriptionCheckout(userId, email) {
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
    line_items: [{
      price_data: {
        currency: CURRENCY,
        unit_amount: SLOT_PRICE * 100,
        recurring: { interval: 'month' },
        product_data: {
          name: 'AutoSnipe Search Slot',
          description: 'One concurrent search slot, billed monthly'
        }
      },
      quantity: 1
    }],
    metadata: { user_id: String(userId) },
    success_url: `${APP_URL}/#/dashboard?subscribed=true`,
    cancel_url: `${APP_URL}/#/buy-slot`
  })

  return { url: session.url }
}

// ===== ADD SLOT (bump quantity on existing subscription) =====

export async function addSlot(userId) {
  if (!stripe) throw new Error('Stripe not configured')

  const db = getDb()
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)

  if (!user.stripe_subscription_id || !user.stripe_subscription_item_id) {
    throw new Error('No active subscription found')
  }

  const item = await stripe.subscriptionItems.retrieve(user.stripe_subscription_item_id)
  const newQuantity = item.quantity + 1

  await stripe.subscriptionItems.update(user.stripe_subscription_item_id, {
    quantity: newQuantity,
    proration_behavior: 'create_prorations'
  })

  // Update locally for snappy UX (webhook will also sync)
  db.prepare('UPDATE users SET paid_slots = ? WHERE id = ?')
    .run(newQuantity, userId)

  return { paid_slots: newQuantity }
}

// ===== CUSTOMER PORTAL =====

export async function createPortalSession(customerId) {
  if (!stripe) throw new Error('Stripe not configured')

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${APP_URL}/#/settings`
  })

  return { url: session.url }
}

// ===== WEBHOOK =====

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
      const userId = session.metadata?.user_id

      if (!userId) {
        console.warn('[Stripe] checkout.session.completed without user_id metadata')
        break
      }

      if (session.mode !== 'subscription') break

      const subscriptionId = session.subscription
      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      const item = subscription.items.data[0]

      // Idempotency check
      const existing = db.prepare('SELECT id FROM purchases WHERE stripe_session_id = ?')
        .get(session.id)

      if (!existing) {
        db.prepare(`
          INSERT INTO purchases (user_id, stripe_session_id, currency, amount)
          VALUES (?, ?, ?, ?)
        `).run(userId, session.id, session.currency, session.amount_total)

        db.prepare(`
          UPDATE users
          SET paid_slots = ?,
              stripe_subscription_id = ?,
              stripe_subscription_item_id = ?
          WHERE id = ?
        `).run(item.quantity, subscriptionId, item.id, userId)

        console.log(`[Stripe] Subscription created for user ${userId} (qty: ${item.quantity}, ${session.currency})`)
      }
      break
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object
      const item = subscription.items.data[0]

      const user = db.prepare('SELECT id FROM users WHERE stripe_subscription_id = ?')
        .get(subscription.id)

      if (user) {
        db.prepare('UPDATE users SET paid_slots = ? WHERE id = ?')
          .run(item.quantity, user.id)
        console.log(`[Stripe] Subscription updated for user ${user.id} (qty: ${item.quantity})`)
      }
      break
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object

      const user = db.prepare('SELECT id FROM users WHERE stripe_subscription_id = ?')
        .get(subscription.id)

      if (user) {
        db.prepare(`
          UPDATE users
          SET paid_slots = 0,
              stripe_subscription_id = NULL,
              stripe_subscription_item_id = NULL
          WHERE id = ?
        `).run(user.id)

        deactivateExcessSearches(db, user.id)
        console.log(`[Stripe] Subscription cancelled for user ${user.id} — paid_slots reset to 0`)
      }
      break
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object
      const user = db.prepare('SELECT id, email FROM users WHERE stripe_customer_id = ?')
        .get(invoice.customer)

      if (user) {
        console.warn(`[Stripe] Payment failed for user ${user.id} (${user.email})`)
      }
      break
    }
  }

  return { received: true }
}

// ===== HELPERS =====

function deactivateExcessSearches(db, userId) {
  const activeSearches = db.prepare(
    'SELECT id FROM searches WHERE user_id = ? AND active = 1 ORDER BY created_at DESC'
  ).all(userId)

  const user = db.prepare('SELECT paid_slots FROM users WHERE id = ?').get(userId)
  const maxSearches = FREE_SEARCHES + (user.paid_slots || 0)

  if (activeSearches.length > maxSearches) {
    const toDeactivate = activeSearches.slice(0, activeSearches.length - maxSearches)
    for (const search of toDeactivate) {
      db.prepare('UPDATE searches SET active = 0 WHERE id = ?').run(search.id)
    }
    console.log(`[Stripe] Deactivated ${toDeactivate.length} excess search(es) for user ${userId}`)
  }
}
