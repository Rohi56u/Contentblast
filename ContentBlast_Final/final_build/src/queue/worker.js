require('dotenv').config()
const { Worker, MetricsTime } = require('bullmq')
const { getRedisConnection, QUEUES } = require('./queueManager')
const logger = require('../config/logger')
const db = require('../database/db')

// ─────────────────────────────────────────────────────────────────
// WORKER — Processes all platform queues
// Runs as separate process: node src/queue/worker.js
// PM2 manages it automatically
// ─────────────────────────────────────────────────────────────────

// Lazy load platform handlers (avoid loading all at startup)
const platformHandlers = {
  telegram: () => require('../platforms/telegram'),
  reddit: () => require('../platforms/reddit'),
  discord: () => require('../platforms/discord'),
  facebook: () => require('../platforms/facebook'),
  whatsapp: () => require('../platforms/whatsapp'),
  linkedin: () => require('../platforms/linkedin'),
  twitter: () => require('../platforms/twitter'),
}

// ─────────────────────────────────────────────────────────────────
// JOB PROCESSOR
// ─────────────────────────────────────────────────────────────────

async function processJob(job) {
  const { platform, groupId, groupName, videoData, caption, campaignId } = job.data

  logger.info(`Processing job ${job.id}: [${platform}] → ${groupName} (attempt ${job.attemptsMade + 1})`)

  const handler = platformHandlers[platform]
  if (!handler) throw new Error(`No handler for platform: ${platform}`)

  const platformModule = handler()

  try {
    // Platform-specific posting
    switch (platform) {
      case 'telegram':
        await platformModule.postToGroup(groupId, caption, videoData?.thumbnailUrl)
        break

      case 'reddit':
        await platformModule.postToSubreddit(groupId, caption)
        break

      case 'discord':
        await platformModule.postToChannel(groupId, caption)
        break

      case 'facebook':
        await platformModule.postToGroup(groupId, null, caption.text || caption)
        break

      case 'whatsapp':
        await platformModule.postToGroup(groupId, caption.text || caption)
        break

      case 'linkedin':
        await platformModule.postToGroup(groupId, caption.text || caption, videoData)
        break

      case 'twitter':
        await platformModule.postTweet(caption.text || caption)
        break

      default:
        throw new Error(`Unknown platform: ${platform}`)
    }

    // ── SUCCESS ──────────────────────────────────────────────
    db.logPost({
      videoUrl: videoData?.shareUrl || videoData?.originalUrl || '',
      videoTitle: videoData?.title || '',
      platform,
      groupId,
      groupName,
      status: 'success'
    })

    db.updateGroupLastPosted(`${platform}_${groupId}`)

    if (campaignId) {
      updateCampaignSuccess(campaignId)
    }

    logger.info(`✅ Job ${job.id} success: [${platform}] ${groupName}`)
    return { success: true, platform, groupId }

  } catch (error) {
    // ── FAILURE ──────────────────────────────────────────────
    const isLastAttempt = job.attemptsMade >= (job.opts.attempts || 3) - 1

    if (isLastAttempt) {
      // All retries exhausted — log as permanently failed
      db.logPost({
        videoUrl: videoData?.shareUrl || '',
        videoTitle: videoData?.title || '',
        platform,
        groupId,
        groupName,
        status: 'failed',
        errorMsg: error.message
      })
      logger.error(`❌ Job ${job.id} permanently failed: ${error.message}`)
    } else {
      logger.warn(`⚠️ Job ${job.id} failed (attempt ${job.attemptsMade + 1}), will retry: ${error.message}`)
    }

    throw error  // BullMQ will handle retry based on backoff config
  }
}

// ─────────────────────────────────────────────────────────────────
// CREATE WORKERS FOR ALL PLATFORMS
// ─────────────────────────────────────────────────────────────────

function createWorkers() {
  const conn = getRedisConnection()
  if (!conn) {
    logger.error('Cannot start workers — Redis not connected')
    logger.info('Starting in DIRECT mode (no queue)')
    return []
  }

  const workers = []

  // Platform-specific concurrency settings
  // (how many simultaneous posts per platform)
  const concurrencySettings = {
    'posts:telegram': 2,    // Telegram: 2 at once
    'posts:reddit': 1,      // Reddit: 1 at a time (strict rate limits)
    'posts:discord': 3,     // Discord: 3 at once (lenient)
    'posts:facebook': 1,    // Facebook: 1 at a time (anti-ban)
    'posts:whatsapp': 1,    // WhatsApp: 1 at a time
    'posts:linkedin': 1,    // LinkedIn: 1 at a time
    'posts:twitter': 1,     // Twitter: 1 at a time
    'posts:scheduled': 1,   // Scheduled: 1 at a time
  }

  for (const [name, queueName] of Object.entries(QUEUES)) {
    const concurrency = concurrencySettings[queueName] || 1

    const worker = new Worker(queueName, processJob, {
      connection: conn,
      concurrency,

      // Rate limiting per worker
      limiter: {
        max: 5,       // Max 5 jobs
        duration: 60000  // Per minute
      },

      metrics: {
        maxDataPoints: MetricsTime.ONE_WEEK
      }
    })

    // Worker events
    worker.on('completed', (job) => {
      logger.info(`✅ Worker completed job ${job.id} [${name}]`)
    })

    worker.on('failed', (job, err) => {
      logger.error(`❌ Worker failed job ${job?.id} [${name}]: ${err.message}`)
    })

    worker.on('error', (err) => {
      logger.error(`Worker error [${name}]: ${err.message}`)
    })

    worker.on('stalled', (jobId) => {
      logger.warn(`Job stalled: ${jobId} [${name}] — will be retried`)
    })

    workers.push(worker)
    logger.info(`Worker started for queue: ${queueName} (concurrency: ${concurrency}) ✅`)
  }

  return workers
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function updateCampaignSuccess(campaignId) {
  try {
    const database = db.getDb()
    database.prepare(`
      UPDATE campaigns SET posted_count = posted_count + 1 WHERE id = ?
    `).run(campaignId)
  } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────
// MAIN — Start workers
// ─────────────────────────────────────────────────────────────────

const workers = createWorkers()

logger.info(`
╔══════════════════════════════════════════════╗
║      ⚙️  BullMQ Workers Started              ║
║      ${workers.length} platform queues active              ║
║      Auto-retry: 3 attempts with backoff     ║
║      Persistent: survives restarts ✅        ║
╚══════════════════════════════════════════════╝
`)

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down workers...')
  await Promise.all(workers.map(w => w.close()))
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception in worker: ${err.message}`)
  // PM2 will restart automatically
  process.exit(1)
})

module.exports = { workers }
