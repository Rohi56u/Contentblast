const { chromium } = require('playwright')
const fs = require('fs')
const config = require('../config/config')
const logger = require('../config/logger')
const { getStealthLaunchOptions, getStealthContextOptions, injectStealthScripts, humanPause } = require('../anti-ban/browserStealth')
const proxyManager = require('../anti-ban/proxyManager')

const SESSION_PATH = './sessions/twitter_session.json'

// ─────────────────────────────────────────────────────────────────
// TWITTER/X AUTOMATION — Playwright based
// Posts tweets with video links, auto hashtags
// No API key needed (Twitter API is paid now)
// ─────────────────────────────────────────────────────────────────

const TWEET_MAX_LENGTH = 280

async function getTwitterBrowser() {
  if (!fs.existsSync('./sessions')) fs.mkdirSync('./sessions', { recursive: true })

  const proxy = await proxyManager.getPlaywrightProxy()
  const browser = await chromium.launch(getStealthLaunchOptions(true))

  let context
  if (fs.existsSync(SESSION_PATH)) {
    context = await browser.newContext({
      ...getStealthContextOptions(null, proxy),
      storageState: SESSION_PATH
    })
    logger.info('Twitter: Loaded existing session')
  } else {
    context = await browser.newContext(getStealthContextOptions(null, proxy))
  }

  return { browser, context }
}

// ─────────────────────────────────────────────────────────────────
// POST TWEET
// ─────────────────────────────────────────────────────────────────

async function postTweet(text, options = {}) {
  let browser, context

  try {
    ;({ browser, context } = await getTwitterBrowser())
    const page = await context.newPage()
    await injectStealthScripts(page)

    // Go to Twitter
    await page.goto('https://twitter.com/home', { waitUntil: 'networkidle', timeout: 30000 })
    await humanPause(2000, 3000)

    // Check if logged in
    if (page.url().includes('login') || page.url().includes('i/flow/login')) {
      await loginTwitter(page, context)
    }

    // Truncate if needed
    const tweetText = text.length > TWEET_MAX_LENGTH
      ? text.slice(0, TWEET_MAX_LENGTH - 3) + '...'
      : text

    // Find tweet compose box
    const composeSelectors = [
      '[data-testid="tweetTextarea_0"]',
      '[placeholder="What is happening?!"]',
      '[placeholder="What\'s happening?"]',
      '.public-DraftEditor-content'
    ]

    let composerFound = false
    for (const sel of composeSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 })
        await page.click(sel)
        composerFound = true
        break
      } catch { /* try next */ }
    }

    if (!composerFound) throw new Error('Tweet composer not found')
    await humanPause(800, 1500)

    // Type tweet
    await page.keyboard.type(tweetText, { delay: 50 + Math.random() * 60 })
    await humanPause(1000, 2000)

    // Click Tweet button
    const tweetBtnSelectors = [
      '[data-testid="tweetButtonInline"]',
      '[data-testid="tweetButton"]',
      'button[type="submit"]'
    ]

    let tweeted = false
    for (const sel of tweetBtnSelectors) {
      try {
        const btn = await page.$(sel)
        if (btn) {
          const isDisabled = await btn.getAttribute('disabled')
          if (!isDisabled) {
            await btn.click()
            tweeted = true
            break
          }
        }
      } catch { /* try next */ }
    }

    if (!tweeted) throw new Error('Could not click tweet button')
    await humanPause(3000, 5000)

    await saveSession(context)
    logger.info('Tweet posted ✅')
    return { success: true }

  } catch (error) {
    logger.error(`Twitter post failed: ${error.message}`)
    throw error
  } finally {
    if (browser) await browser.close()
  }
}

// ─────────────────────────────────────────────────────────────────
// BUILD TWEET TEXT from video data
// ─────────────────────────────────────────────────────────────────

function buildTweetText(videoData, niche = 'general') {
  const { title, shareUrl, channelName } = videoData

  const nicheHashtags = {
    tech: '#Tech #Programming #Developer #Coding',
    gaming: '#Gaming #Gamer #Games #Twitch',
    finance: '#Finance #Investing #Crypto #Money',
    fitness: '#Fitness #Gym #Workout #Health',
    food: '#Food #Foodie #Recipe #Cooking',
    travel: '#Travel #Wanderlust #Explore',
    education: '#Education #Learning #Knowledge',
    entertainment: '#Entertainment #Viral #Trending',
    business: '#Business #Entrepreneur #Startup',
    general: '#Viral #Trending #MustWatch'
  }

  const hashtags = nicheHashtags[niche] || nicheHashtags.general

  // Build tweet — keep it under 280 chars
  let tweet = `🔥 ${title}\n\n${shareUrl}\n\n${hashtags}`

  if (tweet.length > TWEET_MAX_LENGTH) {
    // Shorten title
    const availableForTitle = TWEET_MAX_LENGTH - shareUrl.length - hashtags.length - 10
    const shortTitle = title.slice(0, Math.max(availableForTitle, 30)) + '...'
    tweet = `🔥 ${shortTitle}\n\n${shareUrl}\n\n${hashtags}`
  }

  return tweet.slice(0, TWEET_MAX_LENGTH)
}

// ─────────────────────────────────────────────────────────────────
// POST MULTIPLE TWEETS with delay
// ─────────────────────────────────────────────────────────────────

async function postMultipleTweets(tweetTexts) {
  const results = []

  for (let i = 0; i < tweetTexts.length; i++) {
    try {
      await postTweet(tweetTexts[i])
      results.push({ index: i, status: 'success' })
    } catch (err) {
      results.push({ index: i, status: 'failed', error: err.message })
    }

    if (i < tweetTexts.length - 1) {
      // Twitter rate limit — wait 15-30 min between tweets from same account
      const delay = 900000 + Math.random() * 900000
      logger.info(`Waiting ${(delay/60000).toFixed(0)} min before next tweet...`)
      await sleep(delay)
    }
  }

  return results
}

// ─────────────────────────────────────────────────────────────────
// LOGIN TO TWITTER
// ─────────────────────────────────────────────────────────────────

async function loginTwitter(page, context) {
  const username = process.env.TWITTER_USERNAME
  const password = process.env.TWITTER_PASSWORD

  if (!username || !password) {
    throw new Error('Twitter credentials not set (TWITTER_USERNAME, TWITTER_PASSWORD)')
  }

  await page.goto('https://twitter.com/i/flow/login', { waitUntil: 'networkidle' })
  await humanPause(2000, 3000)

  // Enter username/email
  await page.fill('input[autocomplete="username"]', username)
  await humanPause(500, 1000)
  await page.keyboard.press('Enter')
  await humanPause(1500, 2500)

  // Sometimes Twitter asks for phone/email verification
  const phoneInput = await page.$('input[data-testid="ocfEnterTextTextInput"]')
  if (phoneInput) {
    const phone = process.env.TWITTER_PHONE || username
    await phoneInput.fill(phone)
    await page.keyboard.press('Enter')
    await humanPause(1500, 2000)
  }

  // Enter password
  await page.fill('input[name="password"]', password)
  await humanPause(500, 1000)
  await page.click('[data-testid="LoginForm_Login_Button"]').catch(() => page.keyboard.press('Enter'))
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 })

  if (page.url().includes('login') || page.url().includes('challenge')) {
    throw new Error('Twitter login failed or requires verification')
  }

  await saveSession(context)
  logger.info('Twitter login successful ✅')
}

// ─────────────────────────────────────────────────────────────────
// TEST CONNECTION
// ─────────────────────────────────────────────────────────────────

async function testConnection() {
  try {
    const { browser, context } = await getTwitterBrowser()
    const page = await context.newPage()
    await page.goto('https://twitter.com/home', { timeout: 15000 })
    const isLoggedIn = !page.url().includes('login')
    await browser.close()
    return { success: isLoggedIn, message: isLoggedIn ? 'Twitter connected' : 'Not logged in' }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

async function saveSession(context) {
  try { await context.storageState({ path: SESSION_PATH }) } catch (e) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = {
  postTweet,
  buildTweetText,
  postMultipleTweets,
  testConnection
}
