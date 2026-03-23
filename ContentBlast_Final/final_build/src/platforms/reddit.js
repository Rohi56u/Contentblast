const Snoowrap = require('snoowrap')
const config = require('../config/config')
const logger = require('../config/logger')
const { retryReddit } = require('../core/retryWithBackoff')
const rateLimiter = require('../core/rateLimit')

let reddit = null

function getRedditClient() {
  if (!reddit) {
    if (!config.reddit?.clientId || !config.reddit?.clientSecret) {
      throw new Error('Reddit credentials not set in .env (REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET)')
    }
    reddit = new Snoowrap({
      userAgent: config.reddit.userAgent || 'ContentBlast/2.0',
      clientId: config.reddit.clientId,
      clientSecret: config.reddit.clientSecret,
      username: config.reddit.username,
      password: config.reddit.password
    })
    reddit.config({
      requestDelay: 1000,
      continueAfterRatelimitError: true,
      warnings: false
    })
    logger.info('Reddit client initialized ✅')
  }
  return reddit
}

// ─────────────────────────────────────────────────────────────────
// POST TO SUBREDDIT — with retry + rate limit
// ─────────────────────────────────────────────────────────────────

async function postToSubreddit(subredditName, caption) {
  const cleanSub = subredditName.replace(/^r\//, '').trim()

  // Check rate limit
  const canPost = await rateLimiter.waitUntilAllowed('reddit', cleanSub, 3 * 60 * 1000)
  if (!canPost) {
    throw new Error(`Rate limit: skipping r/${cleanSub}`)
  }

  return retryReddit(async () => {
    const r = getRedditClient()

    try {
      const submission = await r.getSubreddit(cleanSub).submitLink({
        title: caption.title || caption.text || 'Check this out',
        url: caption.text?.match(/https?:\/\/[^\s]+/)?.[0] || caption.text
      })

      const postUrl = `https://reddit.com${submission.permalink}`
      rateLimiter.recordPost('reddit', cleanSub)
      logger.info(`Reddit ✅ r/${cleanSub} → ${postUrl}`)
      return { success: true, postUrl, postId: submission.id }

    } catch (err) {
      // Handle specific Reddit errors
      if (err.message?.includes('SUBREDDIT_NOTALLOWED') ||
          err.message?.includes('SUBREDDIT_BANNED') ||
          err.message?.includes('banned')) {
        const skipErr = new Error(`r/${cleanSub} does not allow link posts or is banned`)
        skipErr.permanent = true  // Don't retry
        throw skipErr
      }

      if (err.message?.includes('ALREADY_SUB')) {
        // Already posted this link — not an error, just skip
        logger.warn(`Reddit: Already submitted to r/${cleanSub}`)
        return { success: true, skipped: true, reason: 'already_submitted' }
      }

      if (err.message?.includes('RATELIMIT') || err.statusCode === 429) {
        // Extract wait time if available
        const match = err.message?.match(/(\d+) (minute|second)/)
        if (match) {
          const waitMs = match[2] === 'minute'
            ? parseInt(match[1]) * 60 * 1000
            : parseInt(match[1]) * 1000
          rateLimiter.setFloodWait('reddit', Math.ceil(waitMs / 1000))
        }
        throw err
      }

      throw err
    }
  }, cleanSub)
}

// ─────────────────────────────────────────────────────────────────
// DISTRIBUTE TO MULTIPLE SUBREDDITS
// ─────────────────────────────────────────────────────────────────

async function distributeToSubreddits(groups, caption, onProgress) {
  const results = []

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]

    try {
      const result = await postToSubreddit(group.group_id || group.id, caption)
      results.push({ groupId: group.id, groupName: group.group_name || group.name, status: 'success', ...result })
      if (onProgress) onProgress({ group, status: 'success', index: i, total: groups.length })
    } catch (error) {
      results.push({ groupId: group.id, groupName: group.group_name || group.name, status: 'failed', error: error.message })
      if (onProgress) onProgress({ group, status: 'failed', error: error.message, index: i, total: groups.length })
    }

    if (i < groups.length - 1) {
      const delay = rateLimiter.getSmartDelay('reddit')
      logger.info(`Reddit: Waiting ${(delay / 1000).toFixed(0)}s (rate limit protection)...`)
      await sleep(delay)
    }
  }

  return results
}

async function testConnection() {
  try {
    const r = getRedditClient()
    const me = await r.getMe()
    return { success: true, username: me.name }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = { postToSubreddit, distributeToSubreddits, testConnection }
