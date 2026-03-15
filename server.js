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
const TELEGRAM_INVITE_LINK = process.env.TELEGRAM_INVITE_LINK

const dbPath = path.join(__dirname, 'subscribers.db')
const db = new Database(dbPath)

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT UNIQUE,
      telegram_username TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_checkout_session_id TEXT,
      subscription_status TEXT,
      current_period_end TEXT,
      has_access INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)
})

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) {
        reject(error)
      } else {
        resolve(this)
      }
    })
  })
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error)
      } else {
        resolve(row)
      }
    })
  })
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error)
      } else {
        resolve(rows)
      }
    })
  })
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

function buildJoinGroupButton() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'Join Private Group',
            url: TELEGRAM_INVITE_LINK,
          },
        ],
      ],
    },
  }
}

async function ensureSubscriberExists(telegramUserId, telegramUsername = null) {
  const existing = await getQuery(
    `SELECT * FROM subscribers WHERE telegram_user_id = ?`,
    [String(telegramUserId)]
  )

  if (!existing) {
    await runQuery(
      `
      INSERT INTO subscribers (
        telegram_user_id,
        telegram_username,
        subscription_status,
        has_access
      )
      VALUES (?, ?, ?, ?)
      `,
      [String(telegramUserId), telegramUsername, 'pending', 0]
    )
  } else if (telegramUsername && telegramUsername !== existing.telegram_username) {
    await runQuery(
      `
      UPDATE subscribers
      SET telegram_username = ?, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
      `,
      [telegramUsername, String(telegramUserId)]
    )
  }
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
    success_url: `${process.env.DOMAIN}/success`,
    cancel_url: `${process.env.DOMAIN}/cancel`,
    metadata: {
      telegramUserId: String(telegramUserId),
    },
  })
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

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object
        const telegramUserId = session.metadata?.telegramUserId

        if (!telegramUserId) {
          console.error('No telegramUserId found in Stripe session metadata')
          return res.status(200).json({ received: true })
        }

        await runQuery(
          `
          UPDATE subscribers
          SET
            stripe_customer_id = ?,
            stripe_checkout_session_id = ?,
            subscription_status = ?,
            has_access = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE telegram_user_id = ?
          `,
          [
            session.customer || null,
            session.id || null,
            'checkout_completed',
            1,
            String(telegramUserId),
          ]
        )

        if (session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription)

          await runQuery(
            `
            UPDATE subscribers
            SET
              stripe_subscription_id = ?,
              subscription_status = ?,
              current_period_end = ?,
              has_access = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE telegram_user_id = ?
            `,
            [
              subscription.id || null,
              subscription.status || 'active',
              subscription.current_period_end
                ? new Date(subscription.current_period_end * 1000).toISOString()
                : null,
              subscription.status === 'active' ? 1 : 0,
              String(telegramUserId),
            ]
          )
        }

        await bot.sendMessage(
          telegramUserId,
          '✅ Payment received successfully.\n\nTap the button below to join the private Telegram group:',
          buildJoinGroupButton()
        )

        console.log('Invite link sent to Telegram user:', telegramUserId)
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
      domain: process.env.DOMAIN,
      telegramWebhook: `${process.env.DOMAIN}${TELEGRAM_WEBHOOK_PATH}`,
      stripeWebhook: `${process.env.DOMAIN}${STRIPE_WEBHOOK_PATH}`,
      subscribersCount: countRow?.count || 0,
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
        telegram_username,
        stripe_customer_id,
        stripe_subscription_id,
        subscription_status,
        current_period_end,
        has_access,
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
    const webhookUrl = `${process.env.DOMAIN}${TELEGRAM_WEBHOOK_PATH}`
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

    const session = await buildCheckoutSession(telegramUserId)

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

    await ensureSubscriberExists(telegramUserId, telegramUsername)

    const session = await buildCheckoutSession(telegramUserId)

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

    await ensureSubscriberExists(telegramUserId, telegramUsername)

    const session = await buildCheckoutSession(telegramUserId)

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

    await bot.sendMessage(
      msg.chat.id,
      `Subscription status: ${subscriber.subscription_status || 'unknown'}\nAccess: ${
        subscriber.has_access ? 'yes' : 'no'
      }`
    )
  } catch (error) {
    console.error('/status error:', error)
    await bot.sendMessage(msg.chat.id, 'Sorry, I could not check your status.')
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