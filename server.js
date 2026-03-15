require('dotenv').config()

const express = require('express')
const Stripe = require('stripe')
const TelegramBot = require('node-telegram-bot-api')

const app = express()
const stripe = Stripe(process.env.STRIPE_SECRET_KEY)
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN)

const PORT = process.env.PORT || 4242
const TELEGRAM_WEBHOOK_PATH = '/telegram-webhook'
const STRIPE_WEBHOOK_PATH = '/stripe-webhook'
const TELEGRAM_INVITE_LINK = process.env.TELEGRAM_INVITE_LINK

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

// Stripe webhook must use raw body
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
          return res.status(200).json({ received: true, warning: 'Missing telegramUserId' })
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

// Normal JSON for everything else
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

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Server is healthy',
    domain: process.env.DOMAIN,
    telegramWebhook: `${process.env.DOMAIN}${TELEGRAM_WEBHOOK_PATH}`,
    stripeWebhook: `${process.env.DOMAIN}${STRIPE_WEBHOOK_PATH}`,
  })
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
    const firstName = msg.from?.first_name || 'there'

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