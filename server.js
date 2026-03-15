require('dotenv').config()

const express = require('express')
const Stripe = require('stripe')
const TelegramBot = require('node-telegram-bot-api')
const Database = require('better-sqlite3')
const path = require('path')

const app = express()
const stripe = Stripe(process.env.STRIPE_SECRET_KEY)
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN)

const PORT = process.env.PORT || 4242
const TELEGRAM_WEBHOOK_PATH = '/telegram-webhook'
const STRIPE_WEBHOOK_PATH = '/stripe-webhook'

const DOMAIN = process.env.DOMAIN
const TELEGRAM_GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID
const ADMIN_TELEGRAM_USER_ID = process.env.ADMIN_TELEGRAM_USER_ID
const TELEGRAM_INVITE_TTL_SECONDS = Number(process.env.TELEGRAM_INVITE_TTL_SECONDS || 3600)

const dbPath = path.join(__dirname, 'subscribers.db')
const db = new Database(dbPath)

db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id TEXT UNIQUE,
    telegram_chat_id TEXT,
    telegram_username TEXT,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    stripe_checkout_session_id TEXT,
    subscription_status TEXT,
    current_period_end TEXT,
    has_access INTEGER DEFAULT 0,
    last_invite_link TEXT,
    invite_link_expires_at TEXT,
    last_payment_at TEXT,
    removal_reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`)

function ensureColumnExists(tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all()
  const exists = columns.some((col) => col.name === columnName)

  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`)
    console.log(`Added missing column: ${columnName}`)
  }
}

ensureColumnExists('subscribers', 'telegram_chat_id', 'TEXT')
ensureColumnExists('subscribers', 'last_invite_link', 'TEXT')
ensureColumnExists('subscribers', 'invite_link_expires_at', 'TEXT')
ensureColumnExists('subscribers', 'last_payment_at', 'TEXT')
ensureColumnExists('subscribers', 'removal_reason', 'TEXT')

function runQuery(sql, params = []) {
  return Promise.resolve(db.prepare(sql).run(params))
}

function getQuery(sql, params = []) {
  return Promise.resolve(db.prepare(sql).get(params))
}

function allQuery(sql, params = []) {
  return Promise.resolve(db.prepare(sql).all(params))
}

function nowIso() {
  return new Date().toISOString()
}

function unixToIso(unixSeconds) {
  if (!unixSeconds) return null
  return new Date(unixSeconds * 1000).toISOString()
}

function hasActiveAccessStatus(status) {
  return ['active', 'trialing'].includes(String(status || '').toLowerCase())
}

function shouldRemoveAccess(status) {
  return ['canceled', 'cancelled', 'unpaid', 'incomplete_expired'].includes(
    String(status || '').toLowerCase()
  )
}

function buildSubscribeButton(sessionUrl) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'Subscribe Now',
            url: sessionUrl,
          },
        ],
      ],
    },
  }
}

function buildJoinGroupButton(inviteLink) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'Join Private Group',
            url: inviteLink,
          },
        ],
      ],
    },
  }
}

async function telegramApi(method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  )

  const data = await response.json()

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram API ${method} failed: ${data.description || response.statusText}`
    )
  }

  return data.result
}

async function createSingleUseInviteLink(telegramUserId) {
  if (!TELEGRAM_GROUP_CHAT_ID) {
    throw new Error('TELEGRAM_GROUP_CHAT_ID is not set')
  }

  const expireUnix = Math.floor(Date.now() / 1000) + TELEGRAM_INVITE_TTL_SECONDS

  const invite = await telegramApi('createChatInviteLink', {
    chat_id: TELEGRAM_GROUP_CHAT_ID,
    name: `sub_${telegramUserId}_${Date.now()}`,
    expire_date: expireUnix,
    member_limit: 1,
  })

  return {
    inviteLink: invite.invite_link,
    expireAtIso: unixToIso(expireUnix),
  }
}

async function revokeInviteLink(inviteLink) {
  if (!inviteLink || !TELEGRAM_GROUP_CHAT_ID) return

  try {
    await telegramApi('revokeChatInviteLink', {
      chat_id: TELEGRAM_GROUP_CHAT_ID,
      invite_link: inviteLink,
    })
  } catch (error) {
    console.error('Failed to revoke invite link:', error.message)
  }
}

async function removeUserFromGroup(telegramUserId) {
  if (!TELEGRAM_GROUP_CHAT_ID || !telegramUserId) return

  try {
    await telegramApi('banChatMember', {
      chat_id: TELEGRAM_GROUP_CHAT_ID,
      user_id: Number(telegramUserId),
      revoke_messages: false,
    })

    await telegramApi('unbanChatMember', {
      chat_id: TELEGRAM_GROUP_CHAT_ID,
      user_id: Number(telegramUserId),
      only_if_banned: true,
    })

    console.log('Removed user from Telegram group:', telegramUserId)
  } catch (error) {
    console.error('Failed to remove user from Telegram group:', telegramUserId, error.message)
  }
}

async function ensureSubscriberExists(telegramUserId, telegramUsername = null, telegramChatId = null) {
  const existing = await getQuery(
    `SELECT * FROM subscribers WHERE telegram_user_id = ?`,
    [String(telegramUserId)]
  )

  if (!existing) {
    await runQuery(
      `
      INSERT INTO subscribers (
        telegram_user_id,
        telegram_chat_id,
        telegram_username,
        subscription_status,
        has_access
      )
      VALUES (?, ?, ?, ?, ?)
      `,
      [String(telegramUserId), telegramChatId ? String(telegramChatId) : null, telegramUsername, 'pending', 0]
    )
    return
  }

  await runQuery(
    `
    UPDATE subscribers
    SET
      telegram_username = COALESCE(?, telegram_username),
      telegram_chat_id = COALESCE(?, telegram_chat_id),
      updated_at = CURRENT_TIMESTAMP
    WHERE telegram_user_id = ?
    `,
    [
      telegramUsername || null,
      telegramChatId ? String(telegramChatId) : null,
      String(telegramUserId),
    ]
  )
}

async function getSubscriberByTelegramUserId(telegramUserId) {
  return getQuery(`SELECT * FROM subscribers WHERE telegram_user_id = ?`, [
    String(telegramUserId),
  ])
}

async function getSubscriberByStripeSubscriptionId(subscriptionId) {
  return getQuery(`SELECT * FROM subscribers WHERE stripe_subscription_id = ?`, [
    subscriptionId,
  ])
}

async function getSubscriberByStripeCustomerId(customerId) {
  return getQuery(`SELECT * FROM subscribers WHERE stripe_customer_id = ?`, [
    customerId,
  ])
}

async function setSubscriberAccess({
  telegramUserId,
  status,
  hasAccess,
  currentPeriodEnd = null,
  stripeCustomerId = null,
  stripeSubscriptionId = null,
  stripeCheckoutSessionId = null,
  lastPaymentAt = null,
  removalReason = null,
}) {
  await runQuery(
    `
    UPDATE subscribers
    SET
      stripe_customer_id = COALESCE(?, stripe_customer_id),
      stripe_subscription_id = COALESCE(?, stripe_subscription_id),
      stripe_checkout_session_id = COALESCE(?, stripe_checkout_session_id),
      subscription_status = ?,
      current_period_end = ?,
      has_access = ?,
      last_payment_at = COALESCE(?, last_payment_at),
      removal_reason = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE telegram_user_id = ?
    `,
    [
      stripeCustomerId,
      stripeSubscriptionId,
      stripeCheckoutSessionId,
      status,
      currentPeriodEnd,
      hasAccess ? 1 : 0,
      lastPaymentAt,
      removalReason,
      String(telegramUserId),
    ]
  )
}

async function createAndSendInviteLink(telegramUserId, chatId) {
  const subscriber = await getSubscriberByTelegramUserId(telegramUserId)

  if (!subscriber) {
    throw new Error('Subscriber not found when trying to create invite link')
  }

  if (subscriber.last_invite_link) {
    await revokeInviteLink(subscriber.last_invite_link)
  }

  const { inviteLink, expireAtIso } = await createSingleUseInviteLink(telegramUserId)

  await runQuery(
    `
    UPDATE subscribers
    SET
      last_invite_link = ?,
      invite_link_expires_at = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE telegram_user_id = ?
    `,
    [inviteLink, expireAtIso, String(telegramUserId)]
  )

  await bot.sendMessage(
    chatId || Number(subscriber.telegram_chat_id) || Number(telegramUserId),
    `✅ Your subscription is active.\n\nHere is your private invite link. It expires soon and only allows one join:`,
    buildJoinGroupButton(inviteLink)
  )

  return inviteLink
}

async function buildCheckoutSession(telegramUserId) {
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [
      {
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1,
      },
    ],
    success_url: `${DOMAIN}/success`,
    cancel_url: `${DOMAIN}/cancel`,
    client_reference_id: String(telegramUserId),
    metadata: {
      telegramUserId: String(telegramUserId),
    },
  })
}

async function getTelegramUserIdFromStripeObjects({
  directTelegramUserId = null,
  customerId = null,
  subscriptionId = null,
}) {
  if (directTelegramUserId) return String(directTelegramUserId)

  if (subscriptionId) {
    const bySub = await getSubscriberByStripeSubscriptionId(subscriptionId)
    if (bySub?.telegram_user_id) return String(bySub.telegram_user_id)
  }

  if (customerId) {
    const byCustomer = await getSubscriberByStripeCustomerId(customerId)
    if (byCustomer?.telegram_user_id) return String(byCustomer.telegram_user_id)
  }

  return null
}

async function handleCheckoutCompleted(session) {
  const telegramUserId = await getTelegramUserIdFromStripeObjects({
    directTelegramUserId: session.metadata?.telegramUserId || session.client_reference_id,
    customerId: session.customer || null,
    subscriptionId: session.subscription || null,
  })

  if (!telegramUserId) {
    console.error('No telegramUserId found for checkout.session.completed')
    return
  }

  await setSubscriberAccess({
    telegramUserId,
    status: 'checkout_completed',
    hasAccess: 0,
    stripeCustomerId: session.customer || null,
    stripeSubscriptionId: session.subscription || null,
    stripeCheckoutSessionId: session.id || null,
    removalReason: null,
  })

  if (session.subscription) {
    const subscription = await stripe.subscriptions.retrieve(session.subscription)

    const isActive = hasActiveAccessStatus(subscription.status)

    await setSubscriberAccess({
      telegramUserId,
      status: subscription.status || 'active',
      hasAccess: isActive,
      currentPeriodEnd: unixToIso(subscription.current_period_end),
      stripeCustomerId: session.customer || null,
      stripeSubscriptionId: subscription.id || null,
      stripeCheckoutSessionId: session.id || null,
      removalReason: null,
    })

    if (isActive) {
      await createAndSendInviteLink(telegramUserId)
    }
  }
}

async function handleInvoicePaid(invoice) {
  const telegramUserId = await getTelegramUserIdFromStripeObjects({
    customerId: invoice.customer || null,
    subscriptionId: invoice.subscription || null,
  })

  if (!telegramUserId) {
    console.error('Could not resolve telegramUserId for invoice.paid')
    return
  }

  let subscription = null

  if (invoice.subscription) {
    subscription = await stripe.subscriptions.retrieve(invoice.subscription)
  }

  const status = subscription?.status || 'active'
  const hasAccess = hasActiveAccessStatus(status)

  await setSubscriberAccess({
    telegramUserId,
    status,
    hasAccess,
    currentPeriodEnd: unixToIso(subscription?.current_period_end),
    stripeCustomerId: invoice.customer || null,
    stripeSubscriptionId: invoice.subscription || null,
    lastPaymentAt: nowIso(),
    removalReason: null,
  })

  console.log('invoice.paid processed for:', telegramUserId)
}

async function handleInvoicePaymentFailed(invoice) {
  const telegramUserId = await getTelegramUserIdFromStripeObjects({
    customerId: invoice.customer || null,
    subscriptionId: invoice.subscription || null,
  })

  if (!telegramUserId) {
    console.error('Could not resolve telegramUserId for invoice.payment_failed')
    return
  }

  await setSubscriberAccess({
    telegramUserId,
    status: 'past_due',
    hasAccess: 0,
    stripeCustomerId: invoice.customer || null,
    stripeSubscriptionId: invoice.subscription || null,
    removalReason: 'invoice.payment_failed',
  })

  const subscriber = await getSubscriberByTelegramUserId(telegramUserId)

  if (subscriber?.last_invite_link) {
    await revokeInviteLink(subscriber.last_invite_link)
  }

  await removeUserFromGroup(telegramUserId)

  try {
    await bot.sendMessage(
      Number(subscriber?.telegram_chat_id) || Number(telegramUserId),
      '⚠️ Your latest subscription payment failed, so your group access has been removed. Please subscribe again or update your payment method.'
    )
  } catch (error) {
    console.error('Failed to notify user after invoice.payment_failed:', error.message)
  }

  console.log('invoice.payment_failed processed for:', telegramUserId)
}

async function handleSubscriptionUpdated(subscription) {
  const telegramUserId = await getTelegramUserIdFromStripeObjects({
    customerId: subscription.customer || null,
    subscriptionId: subscription.id || null,
  })

  if (!telegramUserId) {
    console.error('Could not resolve telegramUserId for customer.subscription.updated')
    return
  }

  const status = subscription.status || 'unknown'
  const hasAccess = hasActiveAccessStatus(status)

  await setSubscriberAccess({
    telegramUserId,
    status,
    hasAccess,
    currentPeriodEnd: unixToIso(subscription.current_period_end),
    stripeCustomerId: subscription.customer || null,
    stripeSubscriptionId: subscription.id || null,
    removalReason: hasAccess ? null : `subscription_updated:${status}`,
  })

  const subscriber = await getSubscriberByTelegramUserId(telegramUserId)

  if (hasAccess) {
    console.log('Subscription updated and still active for:', telegramUserId)
    return
  }

  if (subscriber?.last_invite_link) {
    await revokeInviteLink(subscriber.last_invite_link)
  }

  if (shouldRemoveAccess(status) || status === 'past_due') {
    await removeUserFromGroup(telegramUserId)

    try {
      await bot.sendMessage(
        Number(subscriber?.telegram_chat_id) || Number(telegramUserId),
        `⚠️ Your subscription is now "${status}", so your group access has been removed.`
      )
    } catch (error) {
      console.error('Failed to notify user after subscription.updated:', error.message)
    }
  }

  console.log('customer.subscription.updated processed for:', telegramUserId, status)
}

async function handleSubscriptionDeleted(subscription) {
  const telegramUserId = await getTelegramUserIdFromStripeObjects({
    customerId: subscription.customer || null,
    subscriptionId: subscription.id || null,
  })

  if (!telegramUserId) {
    console.error('Could not resolve telegramUserId for customer.subscription.deleted')
    return
  }

  await setSubscriberAccess({
    telegramUserId,
    status: 'canceled',
    hasAccess: 0,
    currentPeriodEnd: unixToIso(subscription.current_period_end),
    stripeCustomerId: subscription.customer || null,
    stripeSubscriptionId: subscription.id || null,
    removalReason: 'customer.subscription.deleted',
  })

  const subscriber = await getSubscriberByTelegramUserId(telegramUserId)

  if (subscriber?.last_invite_link) {
    await revokeInviteLink(subscriber.last_invite_link)
  }

  await removeUserFromGroup(telegramUserId)

  try {
    await bot.sendMessage(
      Number(subscriber?.telegram_chat_id) || Number(telegramUserId),
      '❌ Your subscription has ended and your group access has been removed.'
    )
  } catch (error) {
    console.error('Failed to notify user after subscription.deleted:', error.message)
  }

  console.log('customer.subscription.deleted processed for:', telegramUserId)
}

app.post(
  STRIPE_WEBHOOK_PATH,
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature']

    let event

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      )
    } catch (error) {
      console.error('Stripe webhook signature verification failed:', error.message)
      return res.status(400).send(`Webhook Error: ${error.message}`)
    }

    try {
      console.log('Stripe event received:', event.type)

      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object)
          break

        case 'invoice.paid':
          await handleInvoicePaid(event.data.object)
          break

        case 'invoice.payment_failed':
          await handleInvoicePaymentFailed(event.data.object)
          break

        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(event.data.object)
          break

        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event.data.object)
          break

        default:
          console.log('Unhandled Stripe event type:', event.type)
          break
      }

      return res.status(200).json({ received: true })
    } catch (error) {
      console.error('Stripe webhook handling error:', error)
      return res.status(500).json({ error: 'Webhook handler failed' })
    }
  }
)

app.use(express.json())

app.get('/', (req, res) => {
  res.send('Telegram paid group server is running')
})

app.get('/success', (req, res) => {
  res.send('Payment successful. You can now return to Telegram.')
})

app.get('/cancel', (req, res) => {
  res.send('Payment cancelled.')
})

app.get('/health', async (req, res) => {
  try {
    const countRow = await getQuery(`SELECT COUNT(*) as count FROM subscribers`)

    res.json({
      ok: true,
      message: 'Server is healthy',
      domain: DOMAIN,
      telegramWebhook: `${DOMAIN}${TELEGRAM_WEBHOOK_PATH}`,
      stripeWebhook: `${DOMAIN}${STRIPE_WEBHOOK_PATH}`,
      subscribersCount: countRow?.count || 0,
      telegramGroupChatIdSet: Boolean(TELEGRAM_GROUP_CHAT_ID),
      adminTelegramUserIdSet: Boolean(ADMIN_TELEGRAM_USER_ID),
      inviteTtlSeconds: TELEGRAM_INVITE_TTL_SECONDS,
    })
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    })
  }
})

app.get('/subscribers', async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT
        telegram_user_id,
        telegram_chat_id,
        telegram_username,
        stripe_customer_id,
        stripe_subscription_id,
        stripe_checkout_session_id,
        subscription_status,
        current_period_end,
        has_access,
        last_invite_link,
        invite_link_expires_at,
        last_payment_at,
        removal_reason,
        created_at,
        updated_at
      FROM subscribers
      ORDER BY created_at DESC
    `)

    res.json(rows)
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    })
  }
})

app.get('/set-webhook', async (req, res) => {
  try {
    const webhookUrl = `${DOMAIN}${TELEGRAM_WEBHOOK_PATH}`
    const result = await bot.setWebHook(webhookUrl)

    console.log('Telegram webhook set:', webhookUrl)

    res.json({
      ok: true,
      webhookUrl,
      result,
    })
  } catch (error) {
    console.error('Failed to set Telegram webhook:', error)
    res.status(500).json({
      ok: false,
      error: error.message,
    })
  }
})

app.get('/webhook-info', async (req, res) => {
  try {
    const info = await bot.getWebHookInfo()
    res.json(info)
  } catch (error) {
    console.error('Failed to get webhook info:', error)
    res.status(500).json({
      ok: false,
      error: error.message,
    })
  }
})

app.post('/create-checkout-session', async (req, res) => {
  try {
    const telegramUserId = req.body?.telegramUserId

    if (!telegramUserId) {
      return res.status(400).json({
        error: 'telegramUserId is required',
      })
    }

    await ensureSubscriberExists(telegramUserId)

    const existing = await getSubscriberByTelegramUserId(telegramUserId)

    if (existing && existing.has_access) {
      return res.status(400).json({
        error: 'User already has active access',
      })
    }

    const session = await buildCheckoutSession(telegramUserId)

    await runQuery(
      `
      UPDATE subscribers
      SET
        stripe_checkout_session_id = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
      `,
      [session.id || null, String(telegramUserId)]
    )

    res.json({ url: session.url })
  } catch (error) {
    console.error('Stripe checkout session error:', error)
    res.status(500).json({
      error: 'Failed to create checkout session',
    })
  }
})

app.post(TELEGRAM_WEBHOOK_PATH, (req, res) => {
  try {
    console.log('Telegram webhook hit')
    bot.processUpdate(req.body)
    res.sendStatus(200)
  } catch (error) {
    console.error('Error processing Telegram update:', error)
    res.sendStatus(500)
  }
})

bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id
    const telegramUserId = msg.from?.id
    const telegramUsername = msg.from?.username || null
    const firstName = msg.from?.first_name || 'there'

    await ensureSubscriberExists(telegramUserId, telegramUsername, chatId)

    const existing = await getSubscriberByTelegramUserId(telegramUserId)

    if (existing?.has_access) {
      await bot.sendMessage(
        chatId,
        `Hi ${firstName} 👋\n\nYou already have an active subscription.\nUse /status to check it, or I can send you a fresh join link now.`
      )

      await createAndSendInviteLink(telegramUserId, chatId)
      return
    }

    const session = await buildCheckoutSession(telegramUserId)

    await runQuery(
      `
      UPDATE subscribers
      SET
        stripe_checkout_session_id = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
      `,
      [session.id || null, String(telegramUserId)]
    )

    await bot.sendMessage(
      chatId,
      `Hi ${firstName} 👋\n\nTo join the paid group, tap the button below to subscribe:`,
      buildSubscribeButton(session.url)
    )

    console.log('/start handled for:', telegramUserId)
  } catch (error) {
    console.error('/start error:', error)

    try {
      await bot.sendMessage(
        msg.chat.id,
        'Sorry, something went wrong creating your payment link.'
      )
    } catch (sendError) {
      console.error('Failed sending /start error message:', sendError)
    }
  }
})

bot.onText(/\/pay/, async (msg) => {
  try {
    const chatId = msg.chat.id
    const telegramUserId = msg.from?.id
    const telegramUsername = msg.from?.username || null

    await ensureSubscriberExists(telegramUserId, telegramUsername, chatId)

    const existing = await getSubscriberByTelegramUserId(telegramUserId)

    if (existing?.has_access) {
      await bot.sendMessage(
        chatId,
        'You already have an active subscription.\n\nI’ve sent you a fresh private group link below:'
      )
      await createAndSendInviteLink(telegramUserId, chatId)
      return
    }

    const session = await buildCheckoutSession(telegramUserId)

    await runQuery(
      `
      UPDATE subscribers
      SET
        stripe_checkout_session_id = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
      `,
      [session.id || null, String(telegramUserId)]
    )

    await bot.sendMessage(
      chatId,
      'Tap the button below to subscribe:',
      buildSubscribeButton(session.url)
    )

    console.log('/pay handled for:', telegramUserId)
  } catch (error) {
    console.error('/pay error:', error)

    try {
      await bot.sendMessage(
        msg.chat.id,
        'Sorry, I could not create a payment link just now.'
      )
    } catch (sendError) {
      console.error('Failed sending /pay error message:', sendError)
    }
  }
})

bot.onText(/\/status/, async (msg) => {
  try {
    const telegramUserId = String(msg.from?.id)

    const subscriber = await getQuery(
      `SELECT * FROM subscribers WHERE telegram_user_id = ?`,
      [telegramUserId]
    )

    if (!subscriber) {
      return bot.sendMessage(
        msg.chat.id,
        'No subscription record found yet. Use /start to begin.'
      )
    }

    let text =
      `Subscription status: ${subscriber.subscription_status || 'unknown'}\n` +
      `Access: ${subscriber.has_access ? 'yes' : 'no'}`

    if (subscriber.current_period_end) {
      text += `\nCurrent period ends: ${subscriber.current_period_end}`
    }

    if (subscriber.invite_link_expires_at) {
      text += `\nLast invite link expiry: ${subscriber.invite_link_expires_at}`
    }

    await bot.sendMessage(msg.chat.id, text)
  } catch (error) {
    console.error('/status error:', error)
    await bot.sendMessage(msg.chat.id, 'Sorry, I could not check your status.')
  }
})

bot.onText(/\/members/, async (msg) => {
  try {
    const telegramUserId = String(msg.from?.id)

    if (!ADMIN_TELEGRAM_USER_ID || telegramUserId !== String(ADMIN_TELEGRAM_USER_ID)) {
      await bot.sendMessage(msg.chat.id, 'You are not allowed to use this command.')
      return
    }

    const members = await allQuery(`
      SELECT
        telegram_user_id,
        telegram_username,
        subscription_status,
        has_access,
        current_period_end,
        updated_at
      FROM subscribers
      ORDER BY created_at DESC
      LIMIT 50
    `)

    if (!members.length) {
      await bot.sendMessage(msg.chat.id, 'No subscribers found.')
      return
    }

    const lines = members.map((member, index) => {
      const username = member.telegram_username ? `@${member.telegram_username}` : '(no username)'
      return (
        `${index + 1}. ${username} | id: ${member.telegram_user_id}\n` +
        `status: ${member.subscription_status || 'unknown'} | access: ${member.has_access ? 'yes' : 'no'}\n` +
        `period_end: ${member.current_period_end || 'n/a'}`
      )
    })

    const chunks = []
    let currentChunk = ''

    for (const line of lines) {
      if ((currentChunk + '\n\n' + line).length > 3500) {
        chunks.push(currentChunk)
        currentChunk = line
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + line
      }
    }

    if (currentChunk) chunks.push(currentChunk)

    for (const chunk of chunks) {
      await bot.sendMessage(msg.chat.id, chunk)
    }
  } catch (error) {
    console.error('/members error:', error)
    await bot.sendMessage(msg.chat.id, 'Sorry, I could not fetch the members list.')
  }
})

bot.on('message', (msg) => {
  console.log('Message received:', {
    text: msg.text,
    from: msg.from?.id,
    chatId: msg.chat?.id,
  })
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})