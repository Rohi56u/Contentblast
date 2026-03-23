const logger = require('../config/logger')

// ─────────────────────────────────────────────────────────────────
// QUEUE MANAGER — with Redis fallback
// If Redis unavailable → system posts directly (no queue)
// If Redis available → BullMQ persistent queue with retry
// ─────────────────────────────────────────────────────────────────

let redisConnection = null
let queues = {}
let isRedisAvailable = false

// Try to connect Redis — if fails, system works without it
async function tryConnectRedis() {
  try {
    const IORedis = require('ioredis')
    const config = require('../config/config')
    const redisUrl = config.redis?.url || 'redis://localhost:6379'

    const conn = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      connectTimeout: 5000,
      retryStrategy: (times) => {
        if (times > 5) return null  // Stop retrying after 5 attempts
        return Math.min(times * 1000, 10000)
      }
    })

    await conn.connect()
    await conn.ping()

    redisConnection = conn
    isRedisAvailable = true

    conn.on('error', (err) => {
      logger.warn(`Redis error (queue disabled): ${err.message}`)
      isRedisAvailable = false
    })
    conn.on('reconnecting', () => {
      logger.info('Redis reconnecting...')
    })
    conn.on('ready', () => {
      isRedisAvailable = true
      logger.info('Redis reconnected ✅')
    })

    logger.info('Redis connected — BullMQ queue active ✅')
    return conn

  } catch (err) {
    logger.warn(`Redis not available (${err.message}) — running in DIRECT mode (posts go immediately, no queue)`)
    isRedisAvailable = false
    return null
  }
}

function getRedisConnection() {
  return redisConnection
}

function getQueue(name) {
  if (!isRedisAvailable || !redisConnection) return null

  if (!queues[name]) {
    try {
      const { Queue } = require('bullmq')
      queues[name] = new Queue(name, {
        connection: redisConnection,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 60000 },
          removeOnComplete: { age: 86400, count: 100 },
          removeOnFail: { age: 604800, count: 200 }
        }
      })
      logger.info(`Queue "${name}" ready ✅`)
    } catch (err) {
      logger.warn(`Queue "${name}" init failed: ${err.message}`)
      return null
    }
  }
  return queues[name]
}

const QUEUES = {
  TELEGRAM:  'posts:telegram',
  REDDIT:    'posts:reddit',
  DISCORD:   'posts:discord',
  FACEBOOK:  'posts:facebook',
  WHATSAPP:  'posts:whatsapp',
  LINKEDIN:  'posts:linkedin',
  TWITTER:   'posts:twitter',
  SCHEDULED: 'posts:scheduled',
}

// Enqueue a post job (or return null if Redis not available)
async function enqueuePost(platform, jobData, options = {}) {
  const queueName = QUEUES[platform.toUpperCase()]
  if (!queueName) throw new Error(`Unknown platform: ${platform}`)

  const queue = getQueue(queueName)
  if (!queue) {
    logger.info(`Direct mode: skipping queue for ${platform}`)
    return null  // Caller will handle directly
  }

  try {
    const job = await queue.add(`post-${platform}`, {
      platform,
      ...jobData,
      enqueuedAt: new Date().toISOString()
    }, {
      priority: options.priority || 5,
      delay: options.delayMs || 0,
      attempts: options.attempts || 3,
    })

    logger.info(`Job queued: ${job.id} [${platform}] → ${jobData.groupId}`)
    return job
  } catch (err) {
    logger.warn(`Queue enqueue failed: ${err.message} — will post directly`)
    return null
  }
}

async function schedulePost(platform, jobData, scheduledAt) {
  const delayMs = new Date(scheduledAt).getTime() - Date.now()
  return enqueuePost(platform, jobData, { delayMs: Math.max(delayMs, 0) })
}

async function enqueueBulkPosts(posts) {
  const jobs = []
  let totalDelay = 0

  for (const post of posts) {
    const staggerDelay = totalDelay + (post.delayMs || 0)
    const job = await enqueuePost(post.platform, post, { delayMs: staggerDelay })
    if (job) jobs.push(job)

    const delays = { telegram: 30000, reddit: 90000, discord: 10000, facebook: 180000, whatsapp: 45000, linkedin: 60000, twitter: 20000 }
    totalDelay += staggerDelay + (delays[post.platform] || 30000)
  }

  return jobs
}

async function getQueueStats() {
  if (!isRedisAvailable) {
    return { available: false, message: 'Redis not connected — running in direct mode' }
  }

  const stats = {}
  for (const [name, queueName] of Object.entries(QUEUES)) {
    try {
      const queue = getQueue(queueName)
      if (!queue) { stats[name] = { available: false }; continue }

      const [waiting, active, completed, failed, delayed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount()
      ])
      stats[name] = { available: true, waiting, active, completed, failed, delayed }
    } catch (e) {
      stats[name] = { available: false, error: e.message }
    }
  }
  return { available: true, queues: stats }
}

async function clearFailed(platform) {
  const queueName = QUEUES[platform.toUpperCase()]
  const queue = getQueue(queueName)
  if (!queue) return
  await queue.clean(0, 1000, 'failed')
  logger.info(`Cleared failed jobs for ${platform}`)
}

async function closeAll() {
  for (const queue of Object.values(queues)) {
    try { await queue.close() } catch (e) {}
  }
  if (redisConnection) {
    try { await redisConnection.quit() } catch (e) {}
    redisConnection = null
    isRedisAvailable = false
  }
}

// Try connecting when module loads (non-blocking)
tryConnectRedis().catch(() => {})

module.exports = {
  getQueue,
  getRedisConnection,
  enqueuePost,
  schedulePost,
  enqueueBulkPosts,
  getQueueStats,
  clearFailed,
  closeAll,
  isRedisAvailable: () => isRedisAvailable,
  QUEUES
}
