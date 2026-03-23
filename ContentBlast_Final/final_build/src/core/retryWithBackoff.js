const logger = require('../config/logger')

// ─────────────────────────────────────────────────────────────────
// UNIVERSAL RETRY ENGINE
// Har platform isko use karta hai
// Koi bhi transient error pe automatically retry hoga
// ─────────────────────────────────────────────────────────────────

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} options
 * @param {number} options.attempts - Max attempts (default 3)
 * @param {number} options.baseDelay - Base delay ms (default 5000)
 * @param {number} options.maxDelay - Max delay ms (default 60000)
 * @param {string} options.label - Log label for this operation
 * @param {Function} options.shouldRetry - Custom function to decide if error is retryable
 */
async function retryWithBackoff(fn, options = {}) {
  const {
    attempts = 3,
    baseDelay = 5000,
    maxDelay = 60000,
    label = 'operation',
    shouldRetry = defaultShouldRetry
  } = options

  let lastError

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      // Check if this error is worth retrying
      if (!shouldRetry(err)) {
        logger.warn(`[Retry] ${label} — non-retryable error: ${err.message}`)
        throw err
      }

      if (attempt === attempts) {
        logger.error(`[Retry] ${label} — all ${attempts} attempts exhausted. Last error: ${err.message}`)
        throw err
      }

      // Exponential backoff with jitter
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1) + jitter(1000), maxDelay)
      logger.warn(`[Retry] ${label} — attempt ${attempt}/${attempts} failed: "${err.message}". Retrying in ${(delay / 1000).toFixed(1)}s...`)
      await sleep(delay)
    }
  }

  throw lastError
}

// ─────────────────────────────────────────────────────────────────
// PLATFORM-SPECIFIC RETRY CONFIGS
// ─────────────────────────────────────────────────────────────────

const RETRY_CONFIGS = {
  telegram: {
    attempts: 3,
    baseDelay: 5000,
    maxDelay: 60000,
    shouldRetry: (err) => {
      const msg = err.message?.toLowerCase() || ''
      // Don't retry: bot kicked, chat not found, not admin
      if (msg.includes('bot was kicked')) return false
      if (msg.includes('chat not found')) return false
      if (msg.includes('forbidden')) return false
      if (msg.includes('token')) return false
      // DO retry: flood wait, network, timeout
      if (msg.includes('flood')) {
        // Extract flood wait time from Telegram error
        const match = msg.match(/retry after (\d+)/)
        if (match) {
          const waitSeconds = parseInt(match[1])
          logger.warn(`[Telegram] Flood wait detected: ${waitSeconds}s`)
          // Return modified error with wait time
          err.floodWaitSeconds = waitSeconds
        }
        return true
      }
      return isNetworkError(err)
    }
  },

  reddit: {
    attempts: 3,
    baseDelay: 10000,
    maxDelay: 120000,
    shouldRetry: (err) => {
      const msg = err.message?.toLowerCase() || ''
      // Don't retry: banned, not allowed, wrong credentials
      if (msg.includes('banned')) return false
      if (msg.includes('forbidden')) return false
      if (msg.includes('invalid_grant')) return false
      if (msg.includes('unauthorized')) return false
      if (msg.includes('403')) return false
      // DO retry: rate limit, network
      if (msg.includes('ratelimit') || msg.includes('rate_limit')) return true
      if (msg.includes('429')) return true
      return isNetworkError(err)
    }
  },

  discord: {
    attempts: 3,
    baseDelay: 3000,
    maxDelay: 30000,
    shouldRetry: (err) => {
      const msg = err.message?.toLowerCase() || ''
      if (msg.includes('missing permissions')) return false
      if (msg.includes('unknown channel')) return false
      if (msg.includes('invalid token')) return false
      if (msg.includes('50013')) return false  // Missing permissions code
      return isNetworkError(err)
    }
  },

  facebook: {
    attempts: 2,     // Facebook needs fewer retries (slow)
    baseDelay: 15000,
    maxDelay: 60000,
    shouldRetry: (err) => {
      const msg = err.message?.toLowerCase() || ''
      if (msg.includes('2fa')) return false
      if (msg.includes('checkpoint')) return false
      if (msg.includes('composer not found')) return false
      return isNetworkError(err)
    }
  },

  whatsapp: {
    attempts: 3,
    baseDelay: 5000,
    maxDelay: 30000,
    shouldRetry: (err) => {
      const msg = err.message?.toLowerCase() || ''
      if (msg.includes('not found')) return false
      if (msg.includes('not a group')) return false
      return true  // Most WhatsApp errors are transient
    }
  },

  linkedin: {
    attempts: 2,
    baseDelay: 10000,
    maxDelay: 60000,
    shouldRetry: (err) => {
      const msg = err.message?.toLowerCase() || ''
      if (msg.includes('verification')) return false
      if (msg.includes('challenge')) return false
      return isNetworkError(err)
    }
  },

  twitter: {
    attempts: 2,
    baseDelay: 10000,
    maxDelay: 60000,
    shouldRetry: (err) => {
      const msg = err.message?.toLowerCase() || ''
      if (msg.includes('verification')) return false
      if (msg.includes('suspended')) return false
      return isNetworkError(err)
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Convenient platform-specific retry wrappers
// ─────────────────────────────────────────────────────────────────

async function retryTelegram(fn, label) {
  return retryWithBackoff(fn, { ...RETRY_CONFIGS.telegram, label: `Telegram:${label}` })
}

async function retryReddit(fn, label) {
  return retryWithBackoff(fn, { ...RETRY_CONFIGS.reddit, label: `Reddit:${label}` })
}

async function retryDiscord(fn, label) {
  return retryWithBackoff(fn, { ...RETRY_CONFIGS.discord, label: `Discord:${label}` })
}

async function retryFacebook(fn, label) {
  return retryWithBackoff(fn, { ...RETRY_CONFIGS.facebook, label: `Facebook:${label}` })
}

async function retryWhatsApp(fn, label) {
  return retryWithBackoff(fn, { ...RETRY_CONFIGS.whatsapp, label: `WhatsApp:${label}` })
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function defaultShouldRetry(err) {
  return isNetworkError(err)
}

function isNetworkError(err) {
  const msg = err.message?.toLowerCase() || ''
  const code = err.code || ''
  return (
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('socket') ||
    msg.includes('fetch') ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND'
  )
}

function jitter(maxMs) {
  return Math.floor(Math.random() * maxMs)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

module.exports = {
  retryWithBackoff,
  retryTelegram,
  retryReddit,
  retryDiscord,
  retryFacebook,
  retryWhatsApp,
  RETRY_CONFIGS,
  isNetworkError
}
