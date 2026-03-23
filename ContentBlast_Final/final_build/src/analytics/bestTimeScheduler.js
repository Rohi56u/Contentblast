require('dotenv').config()
const cron = require('node-cron')
const db = require('../database/db')
const logger = require('../config/logger')
const { enqueuePost, schedulePost } = require('../queue/queueManager')

// ─────────────────────────────────────────────────────────────────
// BEST TIME SCHEDULER
//
// Kya karta hai:
// 1. Platform ke hisaab se best posting times jaanta hai
// 2. Posts ko auto-schedule karta hai peak time par
// 3. Pending scheduled posts check karta hai every minute
// 4. Timezone-aware scheduling
// ─────────────────────────────────────────────────────────────────

// ── PEAK TIMES (Research-based, IST) ─────────────────────────
// These are optimal posting times for maximum reach

const PEAK_TIMES = {
  telegram: [
    { hour: 9, minute: 0, weight: 8 },    // 9 AM
    { hour: 13, minute: 0, weight: 7 },   // 1 PM
    { hour: 18, minute: 0, weight: 9 },   // 6 PM
    { hour: 20, minute: 0, weight: 10 },  // 8 PM — BEST
    { hour: 22, minute: 0, weight: 8 },   // 10 PM
  ],
  reddit: [
    { hour: 8, minute: 0, weight: 7 },    // 8 AM
    { hour: 10, minute: 0, weight: 9 },   // 10 AM — BEST
    { hour: 14, minute: 0, weight: 8 },   // 2 PM
    { hour: 18, minute: 0, weight: 7 },   // 6 PM
  ],
  discord: [
    { hour: 12, minute: 0, weight: 7 },   // 12 PM
    { hour: 17, minute: 0, weight: 9 },   // 5 PM
    { hour: 20, minute: 0, weight: 10 },  // 8 PM — BEST
    { hour: 23, minute: 0, weight: 8 },   // 11 PM
  ],
  facebook: [
    { hour: 9, minute: 0, weight: 8 },    // 9 AM
    { hour: 13, minute: 0, weight: 10 },  // 1 PM — BEST
    { hour: 16, minute: 0, weight: 9 },   // 4 PM
    { hour: 20, minute: 0, weight: 8 },   // 8 PM
  ],
  linkedin: [
    { hour: 8, minute: 0, weight: 9 },    // 8 AM — BEST
    { hour: 12, minute: 0, weight: 8 },   // 12 PM
    { hour: 17, minute: 0, weight: 7 },   // 5 PM
    { hour: 18, minute: 30, weight: 8 },  // 6:30 PM
  ],
  twitter: [
    { hour: 9, minute: 0, weight: 8 },    // 9 AM
    { hour: 12, minute: 0, weight: 9 },   // 12 PM
    { hour: 17, minute: 0, weight: 10 },  // 5 PM — BEST
    { hour: 20, minute: 0, weight: 9 },   // 8 PM
  ],
  whatsapp: [
    { hour: 9, minute: 0, weight: 7 },
    { hour: 13, minute: 30, weight: 8 },
    { hour: 19, minute: 0, weight: 10 },  // 7 PM — BEST
    { hour: 21, minute: 0, weight: 9 },
  ]
}

// ─────────────────────────────────────────────────────────────────
// SETUP SCHEDULED POSTS TABLE
// ─────────────────────────────────────────────────────────────────

function setupScheduledPostsTable() {
  const database = db.getDb()
  database.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id            TEXT PRIMARY KEY,
      campaign_id   TEXT,
      platform      TEXT NOT NULL,
      group_id      TEXT NOT NULL,
      group_name    TEXT,
      video_url     TEXT NOT NULL,
      video_title   TEXT,
      caption_json  TEXT,
      video_data_json TEXT,
      scheduled_for TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      job_id        TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      processed_at  TEXT
    )
  `)
}

// ─────────────────────────────────────────────────────────────────
// GET NEXT BEST TIME FOR PLATFORM
// ─────────────────────────────────────────────────────────────────

function getNextBestTime(platform, fromDate = new Date()) {
  const times = PEAK_TIMES[platform] || PEAK_TIMES.telegram

  const now = new Date(fromDate)
  const candidates = []

  // Check next 7 days
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    for (const time of times) {
      const candidate = new Date(now)
      candidate.setDate(candidate.getDate() + dayOffset)
      candidate.setHours(time.hour, time.minute, 0, 0)

      // Must be in the future (at least 5 min from now)
      if (candidate.getTime() > now.getTime() + 5 * 60 * 1000) {
        candidates.push({
          date: candidate,
          weight: time.weight,
          hoursFromNow: (candidate.getTime() - now.getTime()) / (1000 * 60 * 60)
        })
      }
    }
  }

  if (candidates.length === 0) {
    // Fallback: 1 hour from now
    const fallback = new Date(now.getTime() + 60 * 60 * 1000)
    return fallback
  }

  // Prioritize: high weight AND closer in time
  candidates.sort((a, b) => {
    const scoreA = a.weight * 10 - a.hoursFromNow * 0.5
    const scoreB = b.weight * 10 - b.hoursFromNow * 0.5
    return scoreB - scoreA
  })

  return candidates[0].date
}

// ─────────────────────────────────────────────────────────────────
// SCHEDULE A CAMPAIGN FOR BEST TIMES
// ─────────────────────────────────────────────────────────────────

async function scheduleCampaignForBestTimes(campaignData) {
  const { groups, videoData, captions, campaignId, niche } = campaignData
  const database = db.getDb()

  const { v4: uuidv4 } = require('uuid')
  const scheduledPosts = []
  let lastScheduledTime = {}  // Track last scheduled time per platform

  for (const group of groups) {
    const platform = group.platform

    // Get the next best time after last scheduled for this platform
    const lastTime = lastScheduledTime[platform] || new Date()
    const bestTime = getNextBestTime(platform, lastTime)

    // Add some random offset (±15 min) to avoid exact same time
    const randomOffset = (Math.random() - 0.5) * 30 * 60 * 1000
    const scheduledFor = new Date(bestTime.getTime() + randomOffset)

    // Save to scheduled_posts table
    const postId = uuidv4()
    const caption = captions[platform] || captions.telegram

    database.prepare(`
      INSERT INTO scheduled_posts
      (id, campaign_id, platform, group_id, group_name, video_url, video_title, caption_json, video_data_json, scheduled_for)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      postId,
      campaignId || null,
      platform,
      group.group_id || group.id,
      group.group_name || group.name,
      videoData.shareUrl,
      videoData.title,
      JSON.stringify(caption),
      JSON.stringify(videoData),
      scheduledFor.toISOString()
    )

    scheduledPosts.push({
      id: postId,
      platform,
      groupName: group.group_name || group.name,
      scheduledFor: scheduledFor.toISOString()
    })

    // Update last scheduled time for this platform
    lastScheduledTime[platform] = scheduledFor

    logger.info(`Scheduled [${platform}] ${group.group_name || group.name} for ${scheduledFor.toLocaleString()}`)
  }

  return scheduledPosts
}

// ─────────────────────────────────────────────────────────────────
// CRON JOB — Check and process due scheduled posts
// Runs every minute
// ─────────────────────────────────────────────────────────────────

function startSchedulerCron() {
  logger.info('Starting best-time scheduler cron...')

  // Run every minute
  cron.schedule('* * * * *', async () => {
    try {
      await processDuePosts()
    } catch (err) {
      logger.error(`Scheduler cron error: ${err.message}`)
    }
  })

  // Daily cleanup of old completed posts
  cron.schedule('0 3 * * *', async () => {
    cleanupOldPosts()
  })

  logger.info('Scheduler cron started ✅ (runs every minute)')
}

async function processDuePosts() {
  const database = db.getDb()

  // Get all pending posts that are due
  const duePosts = database.prepare(`
    SELECT * FROM scheduled_posts
    WHERE status = 'pending'
    AND scheduled_for <= datetime('now')
    ORDER BY scheduled_for ASC
    LIMIT 10
  `).all()

  if (duePosts.length === 0) return

  logger.info(`Processing ${duePosts.length} due scheduled posts...`)

  for (const post of duePosts) {
    try {
      // Mark as processing
      database.prepare(`
        UPDATE scheduled_posts SET status = 'processing' WHERE id = ?
      `).run(post.id)

      // Add to queue for immediate processing
      const caption = JSON.parse(post.caption_json || '{}')
      const videoData = JSON.parse(post.video_data_json || '{}')

      await enqueuePost(post.platform, {
        groupId: post.group_id,
        groupName: post.group_name,
        videoData,
        caption,
        campaignId: post.campaign_id
      }, { priority: 1 })  // High priority

      // Mark as queued
      database.prepare(`
        UPDATE scheduled_posts
        SET status = 'queued', processed_at = datetime('now')
        WHERE id = ?
      `).run(post.id)

      logger.info(`✅ Queued scheduled post: [${post.platform}] ${post.group_name}`)

    } catch (err) {
      // Mark as failed
      database.prepare(`
        UPDATE scheduled_posts SET status = 'failed' WHERE id = ?
      `).run(post.id)
      logger.error(`Failed to process scheduled post ${post.id}: ${err.message}`)
    }
  }
}

function cleanupOldPosts() {
  const database = db.getDb()
  const deleted = database.prepare(`
    DELETE FROM scheduled_posts
    WHERE status IN ('queued', 'failed')
    AND created_at < datetime('now', '-30 days')
  `).run()
  logger.info(`Cleaned up ${deleted.changes} old scheduled posts`)
}

// ─────────────────────────────────────────────────────────────────
// GET SCHEDULED POSTS
// ─────────────────────────────────────────────────────────────────

function getScheduledPosts(status = 'pending', limit = 50) {
  const database = db.getDb()
  return database.prepare(`
    SELECT * FROM scheduled_posts
    WHERE status = ?
    ORDER BY scheduled_for ASC
    LIMIT ?
  `).all(status, limit)
}

function getPeakTimes() {
  return PEAK_TIMES
}

// Setup tables
try { setupScheduledPostsTable() } catch (e) {}

// Start cron if running as main process
if (require.main === module) {
  startSchedulerCron()

  logger.info(`
╔══════════════════════════════════════════════╗
║      ⏰ Best Time Scheduler Running          ║
║      Checking due posts every minute         ║
║      PM2 manages auto-restart                ║
╚══════════════════════════════════════════════╝
  `)

  // Keep process alive
  process.on('SIGINT', () => {
    logger.info('Scheduler shutting down')
    process.exit(0)
  })
}

module.exports = {
  getNextBestTime,
  scheduleCampaignForBestTimes,
  startSchedulerCron,
  getScheduledPosts,
  getPeakTimes,
  processDuePosts
}
