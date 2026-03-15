require('dotenv').config()

const express = require('express')
const Stripe = require('stripe')
const TelegramBot = require('node-telegram-bot-api')

const app = express()
const stripe = Stripe(process.env.STRIPE_SECRET_KEY)

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: true,
})

app.use(express.json())

function buildCheckoutSession(telegramUserId) {
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

app.get('/', (req, res) => {
  res.send('Telegram paid group server is running')
})

app.get('/success', (req, res) => {
  res.send('Payment successful. You can now return to Telegram.')
})

app.get('/cancel', (req, res) => {
  res.send('Payment cancelled.')
})

app.post('/create-checkout-session', async (req, res) => {
  try {
    const telegramUserId = req.body?.telegramUserId

    if (!telegramUserId) {
      return res.status(400).json({ error: 'telegramUserId is required' })
    }

    const session = await buildCheckoutSession(telegramUserId)

    res.json({ url: session.url })
  } catch (error) {
    console.error('Stripe checkout session error:', error)
    res.status(500).json({ error: 'Failed to create checkout session' })
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
  } catch (error) {
    console.error('/start error:', error)
    await bot.sendMessage(
      msg.chat.id,
      'Sorry, something went wrong creating your payment link.'
    )
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
  } catch (error) {
    console.error('/pay error:', error)
    await bot.sendMessage(
      msg.chat.id,
      'Sorry, I could not create a payment link just now.'
    )
  }
})

bot.on('polling_error', (error) => {
  console.error('Telegram polling error:', error)
})

const PORT = process.env.PORT || 4242
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})