const logger = require('../config/logger')

// ─────────────────────────────────────────────────────────────────
// RATE LIMIT TRACKER
// Platform ke hisaab se posting limits track karta hai
// Ban se bachata hai, automatically smart delays add karta hai
// ─────────────────────────────────────────────────────────────────

class RateLimiter {
  constructor() {
    // Track post timestamps per platform per group
    this.postHistory = new Map()  // key: `platform:groupId` → [timestamps]

    // Platform limits (posts per time window)
    this.limits = {
      telegram: { maxPosts: 20, windowMs: 60 * 60 * 1000 },    // 20/hour
      reddit:   { maxPosts: 5,  windowMs: 60 * 60 * 1000 },    // 5/hour (Reddit is strict)
      discord:  { maxPosts: 30, windowMs: 60 * 60 * 1000 },    // 30/hour
      facebook: { maxPosts: 10, windowMs: 60 * 60 * 1000 },    // 10/hour
      whatsapp: { maxPosts: 15, windowMs: 60 * 60 * 1000 },    // 15/hour
      linkedin: { maxPosts: 10, windowMs: 60 * 60 * 1000 },    // 10/hour
      twitter:  { maxPosts: 5,  windowMs: 60 * 60 * 1000 },    // 5/hour (Twitter very strict)
    }

    // Per-group minimum gaps (ms between posts to same group)
    this.groupMinGap = {
      telegram: 30 * 1000,         // 30s between posts to same group
      reddit:   24 * 60 * 60 * 1000, // 24h between posts to same subreddit
      discord:  10 * 1000,          // 10s
      facebook: 5 * 60 * 1000,      // 5 min
      whatsapp: 60 * 1000,          // 1 min
      linkedin: 60 * 1000,          // 1 min
      twitter:  15 * 60 * 1000,     // 15 min between tweets
    }

    // Flood wait tracking (per platform)
    this.floodWaits = new Map()  // platform → { until: timestamp }
  }

  // ── CHECK IF CAN POST ──────────────────────────────────────────

  canPost(platform, groupId) {
    const key = `${platform}:${groupId}`
    const now = Date.now()
    const limit = this.limits[platform]

    if (!limit) return { allowed: true }

    // Check if in flood wait
    const floodWait = this.floodWaits.get(platform)
    if (floodWait && now < floodWait.until) {
      const waitSecs = Math.ceil((floodWait.until - now) / 1000)
      return {
        allowed: false,
        reason: 'flood_wait',
        waitMs: floodWait.until - now,
        message: `Platform ${platform} flood wait: ${waitSecs}s remaining`
      }
    }

    // Check per-group minimum gap
    const history = this.postHistory.get(key) || []
    const lastPost = history[history.length - 1]
    const minGap = this.groupMinGap[platform] || 30000

    if (lastPost && (now - lastPost) < minGap) {
      const waitMs = minGap - (now - lastPost)
      return {
        allowed: false,
        reason: 'min_gap',
        waitMs,
        message: `Too soon to post to ${groupId} again (wait ${(waitMs / 1000).toFixed(0)}s)`
      }
    }

    // Check hourly limit for this platform
    const windowStart = now - limit.windowMs
    const recentPosts = history.filter(t => t > windowStart)

    if (recentPosts.length >= limit.maxPosts) {
      const oldestInWindow = recentPosts[0]
      const waitMs = (oldestInWindow + limit.windowMs) - now
      return {
        allowed: false,
        reason: 'hourly_limit',
        waitMs: Math.max(waitMs, 0),
        message: `${platform} hourly limit reached (${recentPosts.length}/${limit.maxPosts}). Wait ${(waitMs / 60000).toFixed(1)} min.`
      }
    }

    return { allowed: true }
  }

  // ── RECORD A POST ──────────────────────────────────────────────

  recordPost(platform, groupId) {
    const key = `${platform}:${groupId}`
    const history = this.postHistory.get(key) || []
    history.push(Date.now())

    // Keep only last 100 entries per group
    if (history.length > 100) history.splice(0, history.length - 100)
    this.postHistory.set(key, history)
  }

  // ── SET FLOOD WAIT ─────────────────────────────────────────────

  setFloodWait(platform, waitSeconds) {
    const until = Date.now() + (waitSeconds * 1000) + 5000  // +5s buffer
    this.floodWaits.set(platform, { until })
    logger.warn(`[RateLimit] ${platform} flood wait set: ${waitSeconds}s`)
  }

  // ── WAIT UNTIL ALLOWED (auto-waits if needed) ─────────────────

  async waitUntilAllowed(platform, groupId, maxWaitMs = 10 * 60 * 1000) {
    const start = Date.now()

    while (true) {
      const check = this.canPost(platform, groupId)
      if (check.allowed) return true

      const elapsed = Date.now() - start
      if (elapsed + check.waitMs > maxWaitMs) {
        logger.warn(`[RateLimit] Skipping ${platform}:${groupId} — wait too long (${(check.waitMs / 60000).toFixed(1)} min)`)
        return false
      }

      logger.info(`[RateLimit] ${check.message} — waiting...`)
      await sleep(Math.min(check.waitMs, 30000))  // Wait in chunks of 30s
    }
  }

  // ── GET SMART DELAY between posts ─────────────────────────────
  // Returns recommended delay before next post on this platform

  getSmartDelay(platform) {
    const delays = {
      telegram: { min: 8000,   max: 20000  },   // 8-20s
      reddit:   { min: 60000,  max: 120000 },   // 1-2 min
      discord:  { min: 3000,   max: 10000  },   // 3-10s
      facebook: { min: 120000, max: 300000 },   // 2-5 min
      whatsapp: { min: 30000,  max: 90000  },   // 30-90s
      linkedin: { min: 60000,  max: 180000 },   // 1-3 min
      twitter:  { min: 900000, max: 1800000 },  // 15-30 min (Twitter very strict)
    }
    const d = delays[platform] || { min: 15000, max: 45000 }
    return d.min + Math.floor(Math.random() * (d.max - d.min))
  }

  // ── STATS ──────────────────────────────────────────────────────

  getStats() {
    const stats = {}
    for (const [key, history] of this.postHistory.entries()) {
      const now = Date.now()
      const [platform, groupId] = key.split(':')
      const limit = this.limits[platform]
      if (!limit) continue
      const recentPosts = history.filter(t => t > now - limit.windowMs).length
      stats[key] = { recentPosts, limit: limit.maxPosts }
    }
    return stats
  }
}

// Singleton — shared across all platform modules
const rateLimiter = new RateLimiter()

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

module.exports = rateLimiter
