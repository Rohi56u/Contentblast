const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const config = require('../config/config')
const logger = require('../config/logger')
const {
  getStealthLaunchOptions,
  getStealthContextOptions,
  injectStealthScripts,
  humanPause,
  humanType
} = require('../anti-ban/browserStealth')
const proxyManager = require('../anti-ban/proxyManager')

const SESSION_PATH = config.facebook.sessionPath || './sessions/facebook_session.json'
const SESSION_DIR = path.dirname(SESSION_PATH)

// ─────────────────────────────────────────────────────────────────
// FACEBOOK AUTOMATION
// Uses Playwright + BrowserStealth + Proxy Rotation
// No API key needed — 100% FREE
// ─────────────────────────────────────────────────────────────────

async function getFacebookBrowser() {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true })

  // Get proxy for this session
  const proxyConfig = await proxyManager.getPlaywrightProxy()

  // Stealth browser launch
  const browser = await chromium.launch(getStealthLaunchOptions(true))

  let context
  if (fs.existsSync(SESSION_PATH)) {
    logger.info('Facebook: Loading existing session...')
    context = await browser.newContext({
      ...getStealthContextOptions(null, proxyConfig),
      storageState: SESSION_PATH
    })
  } else {
    context = await browser.newContext(getStealthContextOptions(null, proxyConfig))
  }

  return { browser, context }
}

// ─────────────────────────────────────────────────────────────────
// LOGIN TO FACEBOOK
// ─────────────────────────────────────────────────────────────────

async function loginFacebook() {
  const { browser, context } = await getFacebookBrowser()
  const page = await context.newPage()

  // Inject stealth scripts to hide automation
  await injectStealthScripts(page)

  try {
    logger.info('Facebook: Navigating to login page...')
    await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle', timeout: 30000 })
    await humanPause(1500, 2500)

    // Already logged in check
    if (!await page.$('#email') && !await page.$('[name="email"]')) {
      logger.info('Facebook: Already logged in ✅')
      await saveSession(context)
      return { browser, context, page }
    }

    logger.info('Facebook: Filling credentials...')
    await humanType(page, '#email', config.facebook.email)
    await humanPause(600, 1200)
    await humanType(page, '#pass', config.facebook.password)
    await humanPause(600, 1200)

    await page.click('[name="login"]')
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 })

    if (page.url().includes('checkpoint') || page.url().includes('two_step')) {
      throw new Error('Facebook requires 2FA verification. Please complete manually first, then re-run.')
    }

    await saveSession(context)
    logger.info('Facebook: Login successful ✅')
    return { browser, context, page }

  } catch (error) {
    await browser.close()
    throw error
  }
}

// ─────────────────────────────────────────────────────────────────
// POST TO FACEBOOK GROUP
// ─────────────────────────────────────────────────────────────────

async function postToGroup(groupId, groupUrl, postText) {
  let browser, context, page

  try {
    ;({ browser, context } = await getFacebookBrowser())
    page = await context.newPage()
    await injectStealthScripts(page)

    const url = groupUrl || `https://www.facebook.com/groups/${groupId}`
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    await humanPause(2000, 3500)

    // If redirected to login, re-login
    if (page.url().includes('login')) {
      await browser.close()
      ;({ browser, context } = await loginFacebook())
      page = await context.newPage()
      await injectStealthScripts(page)
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
      await humanPause(2000, 3000)
    }

    // Find the "Write something..." post composer
    const composerSelectors = [
      '[data-testid="status-attachment-mentions-input"]',
      '[placeholder="Write something..."]',
      '[placeholder="What\'s on your mind?"]',
      '[aria-label="Write something..."]',
      '[role="button"].x1i10hfl'
    ]

    let composerClicked = false
    for (const selector of composerSelectors) {
      try {
        const el = await page.$(selector)
        if (el) {
          await el.click()
          composerClicked = true
          logger.info(`Facebook: Composer found with selector: ${selector}`)
          break
        }
      } catch { /* try next */ }
    }

    if (!composerClicked) throw new Error('Could not find Facebook post composer')
    await humanPause(1500, 2500)

    // Type post — human-like
    await page.keyboard.type(postText, { delay: 60 + Math.random() * 50 })
    await humanPause(1500, 2500)

    // Click Post button
    const postBtnSelectors = [
      '[data-testid="react-composer-post-button"]',
      '[aria-label="Post"]',
      'button[type="submit"]',
      '.x1n2onr6 button[type="submit"]'
    ]

    let posted = false
    for (const selector of postBtnSelectors) {
      try {
        const btn = await page.$(selector)
        if (btn) {
          await btn.click()
          posted = true
          break
        }
      } catch { /* try next */ }
    }

    if (!posted) throw new Error('Could not find Facebook Post button')

    await humanPause(3000, 5000)
    await saveSession(context)

    logger.info(`Facebook: Posted to group ${groupId} ✅`)
    return { success: true }

  } catch (error) {
    // If proxy failed, mark it
    const proxy = await proxyManager.getProxy()
    if (proxy) proxyManager.markFailed(proxy.url)

    logger.error(`Facebook post failed for group ${groupId}: ${error.message}`)
    throw error
  } finally {
    if (browser) await browser.close()
  }
}

// ─────────────────────────────────────────────────────────────────
// DISTRIBUTE TO MULTIPLE GROUPS
// ─────────────────────────────────────────────────────────────────

async function distributeToGroups(groups, captionText, onProgress) {
  const results = []

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]

    try {
      await postToGroup(group.group_id, group.group_url || null, captionText)
      results.push({ groupId: group.id, groupName: group.group_name, status: 'success' })
      if (onProgress) onProgress({ group, status: 'success', index: i, total: groups.length })
    } catch (error) {
      results.push({ groupId: group.id, groupName: group.group_name, status: 'failed', error: error.message })
      if (onProgress) onProgress({ group, status: 'failed', error: error.message, index: i, total: groups.length })
    }

    // Facebook needs long delays to avoid detection (2-5 minutes)
    if (i < groups.length - 1) {
      const delay = 120000 + Math.random() * 180000
      logger.info(`Facebook: Waiting ${(delay / 60000).toFixed(1)} min before next post...`)
      await sleep(delay)
    }
  }

  return results
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

async function saveSession(context) {
  try {
    await context.storageState({ path: SESSION_PATH })
    logger.info('Facebook session saved ✅')
  } catch (err) {
    logger.warn(`Could not save Facebook session: ${err.message}`)
  }
}

async function testConnection() {
  try {
    const { browser, context, page } = await loginFacebook()
    const loggedIn = !page.url().includes('login')
    await browser.close()
    return { success: loggedIn, message: loggedIn ? 'Facebook connected' : 'Not logged in' }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

module.exports = {
  postToGroup,
  distributeToGroups,
  loginFacebook,
  testConnection
}
