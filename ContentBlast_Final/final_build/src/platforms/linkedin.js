const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const config = require('../config/config')
const logger = require('../config/logger')
const { getStealthLaunchOptions, getStealthContextOptions, injectStealthScripts, humanPause, humanType } = require('../anti-ban/browserStealth')
const proxyManager = require('../anti-ban/proxyManager')

const SESSION_PATH = './sessions/linkedin_session.json'

// ─────────────────────────────────────────────────────────────────
// LINKEDIN AUTOMATION — Playwright based, No API needed
// Posts to LinkedIn profile feed + groups
// ─────────────────────────────────────────────────────────────────

async function getLinkedInBrowser() {
  if (!fs.existsSync('./sessions')) fs.mkdirSync('./sessions', { recursive: true })

  const proxy = await proxyManager.getPlaywrightProxy()
  const browser = await chromium.launch(getStealthLaunchOptions(true))

  let context
  if (fs.existsSync(SESSION_PATH)) {
    context = await browser.newContext({
      ...getStealthContextOptions(null, proxy),
      storageState: SESSION_PATH
    })
    logger.info('LinkedIn: Loaded existing session')
  } else {
    context = await browser.newContext(getStealthContextOptions(null, proxy))
  }

  return { browser, context }
}

// ─────────────────────────────────────────────────────────────────
// POST TO LINKEDIN FEED (Your personal profile)
// ─────────────────────────────────────────────────────────────────

async function postToFeed(text, videoUrl = null) {
  let browser, context

  try {
    ;({ browser, context } = await getLinkedInBrowser())
    const page = await context.newPage()
    await injectStealthScripts(page)

    // Go to LinkedIn
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle', timeout: 30000 })
    await humanPause(2000, 3000)

    // Check if logged in
    if (page.url().includes('login') || page.url().includes('signup')) {
      await loginLinkedIn(page, context)
    }

    // Click "Start a post" button
    const startPostSelectors = [
      'button[aria-label="Start a post"]',
      '.share-box-feed-entry__trigger',
      '[placeholder="What do you want to talk about?"]',
      '.share-creation-state__placeholder'
    ]

    let clicked = false
    for (const sel of startPostSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 })
        await page.click(sel)
        clicked = true
        break
      } catch { /* try next */ }
    }

    if (!clicked) throw new Error('Could not find LinkedIn post button')
    await humanPause(1500, 2500)

    // Type the post content
    const postText = videoUrl ? `${text}\n\n${videoUrl}` : text
    await page.keyboard.type(postText, { delay: 60 + Math.random() * 40 })
    await humanPause(1000, 2000)

    // Click Post button
    const postBtnSelectors = [
      'button.share-actions__primary-action',
      'button[aria-label="Post"]',
      '.share-box-footer__main-actions button'
    ]

    let posted = false
    for (const sel of postBtnSelectors) {
      try {
        const btn = await page.$(sel)
        if (btn) {
          await btn.click()
          posted = true
          break
        }
      } catch { /* try next */ }
    }

    if (!posted) throw new Error('Could not find LinkedIn post submit button')

    await humanPause(3000, 5000)
    await saveSession(context)

    logger.info('LinkedIn post published ✅')
    return { success: true }

  } catch (error) {
    logger.error(`LinkedIn post failed: ${error.message}`)
    throw error
  } finally {
    if (browser) await browser.close()
  }
}

// ─────────────────────────────────────────────────────────────────
// POST TO LINKEDIN GROUP
// ─────────────────────────────────────────────────────────────────

async function postToGroup(groupId, text, videoData = null) {
  let browser, context

  try {
    ;({ browser, context } = await getLinkedInBrowser())
    const page = await context.newPage()
    await injectStealthScripts(page)

    const groupUrl = groupId.startsWith('http')
      ? groupId
      : `https://www.linkedin.com/groups/${groupId}/`

    await page.goto(groupUrl, { waitUntil: 'networkidle', timeout: 30000 })
    await humanPause(2000, 3000)

    if (page.url().includes('login')) {
      await loginLinkedIn(page, context)
      await page.goto(groupUrl, { waitUntil: 'networkidle', timeout: 30000 })
    }

    // Find group post input
    const inputSelectors = [
      '[placeholder="Start a conversation"]',
      '[placeholder="Create a post"]',
      '.share-creation-state__placeholder'
    ]

    let clicked = false
    for (const sel of inputSelectors) {
      try {
        await page.click(sel, { timeout: 5000 })
        clicked = true
        break
      } catch { /* try next */ }
    }

    if (!clicked) throw new Error('Could not find group post input')
    await humanPause(1000, 2000)

    const fullText = videoData?.shareUrl ? `${text}\n\n${videoData.shareUrl}` : text
    await page.keyboard.type(fullText, { delay: 60 + Math.random() * 40 })
    await humanPause(1000, 2000)

    // Post
    const postBtn = await page.$('button[aria-label="Post"]') || await page.$('.share-actions__primary-action')
    if (!postBtn) throw new Error('Post button not found')
    await postBtn.click()

    await humanPause(3000, 4000)
    await saveSession(context)

    logger.info(`LinkedIn group ${groupId} posted ✅`)
    return { success: true }

  } catch (error) {
    logger.error(`LinkedIn group post failed: ${error.message}`)
    throw error
  } finally {
    if (browser) await browser.close()
  }
}

// ─────────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────────

async function loginLinkedIn(page, context) {
  const email = process.env.LINKEDIN_EMAIL
  const password = process.env.LINKEDIN_PASSWORD

  if (!email || !password) {
    throw new Error('LinkedIn credentials not set in .env (LINKEDIN_EMAIL, LINKEDIN_PASSWORD)')
  }

  await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle' })
  await humanPause(1000, 2000)

  await page.fill('#username', email)
  await humanPause(500, 1000)
  await page.fill('#password', password)
  await humanPause(500, 1000)

  await page.click('[type="submit"]')
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 })

  if (page.url().includes('challenge') || page.url().includes('checkpoint')) {
    throw new Error('LinkedIn requires verification. Complete manually first.')
  }

  await saveSession(context)
  logger.info('LinkedIn login successful ✅')
}

// ─────────────────────────────────────────────────────────────────
// DISTRIBUTE TO MULTIPLE GROUPS
// ─────────────────────────────────────────────────────────────────

async function distributeToGroups(groups, captionText, videoData, onProgress) {
  const results = []

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    try {
      await postToGroup(group.group_id, captionText, videoData)
      results.push({ groupId: group.id, groupName: group.group_name, status: 'success' })
      if (onProgress) onProgress({ group, status: 'success', index: i, total: groups.length })
    } catch (error) {
      results.push({ groupId: group.id, groupName: group.group_name, status: 'failed', error: error.message })
      if (onProgress) onProgress({ group, status: 'failed', error: error.message, index: i, total: groups.length })
    }

    if (i < groups.length - 1) {
      const delay = 90000 + Math.random() * 120000  // 1.5-3.5 min between LinkedIn posts
      logger.info(`Waiting ${(delay/60000).toFixed(1)} min before next LinkedIn post...`)
      await sleep(delay)
    }
  }
  return results
}

async function saveSession(context) {
  try {
    await context.storageState({ path: SESSION_PATH })
  } catch (e) {}
}

async function testConnection() {
  try {
    const { browser, context } = await getLinkedInBrowser()
    const page = await context.newPage()
    await page.goto('https://www.linkedin.com/feed/', { timeout: 15000 })
    const isLoggedIn = !page.url().includes('login')
    await browser.close()
    return { success: isLoggedIn, message: isLoggedIn ? 'LinkedIn connected' : 'Not logged in' }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = {
  postToFeed,
  postToGroup,
  distributeToGroups,
  testConnection
}
