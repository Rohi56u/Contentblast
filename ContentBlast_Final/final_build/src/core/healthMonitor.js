require('dotenv').config()
const cron = require('node-cron')
const logger = require('../config/logger')
const db = require('../database/db')

// ─────────────────────────────────────────────────────────────────
// HEALTH MONITOR
// Runs every 5 minutes, checks everything is working
// If something is broken → fixes it automatically
// ─────────────────────────────────────────────────────────────────

const health = {
  lastChecked: null,
  status: {},
  alerts: [],
  upSince: new Date().toISOString()
}

// ─────────────────────────────────────────────────────────────────
// CHECK ALL SYSTEMS
// ─────────────────────────────────────────────────────────────────

async function checkAllSystems() {
  health.lastChecked = new Date().toISOString()
  const results = {}

  // 1. Database check
  results.database = await checkDatabase()

  // 2. Redis check (optional — system works without it)
  results.redis = await checkRedis()

  // 3. Disk space check
  results.disk = await checkDiskSpace()

  // 4. Memory check
  results.memory = checkMemory()

  // 5. Session files check
  results.sessions = checkSessions()

  // 6. Recent post activity
  results.activity = checkRecentActivity()

  health.status = results

  // Log summary
  const allOk = Object.values(results).every(r => r.ok)
  if (allOk) {
    logger.info('✅ Health check: All systems OK')
  } else {
    const failed = Object.entries(results)
      .filter(([, v]) => !v.ok)
      .map(([k, v]) => `${k}: ${v.message}`)
      .join(', ')
    logger.warn(`⚠️ Health check issues: ${failed}`)
  }

  return results
}

// ─────────────────────────────────────────────────────────────────
// INDIVIDUAL CHECKS
// ─────────────────────────────────────────────────────────────────

async function checkDatabase() {
  try {
    const database = db.getDb()
    const result = database.prepare('SELECT 1 as ok').get()
    return { ok: true, message: 'Database connected' }
  } catch (err) {
    return { ok: false, message: `Database error: ${err.message}` }
  }
}

async function checkRedis() {
  try {
    const { getRedisConnection } = require('../queue/queueManager')
    const conn = getRedisConnection()
    if (!conn) return { ok: false, message: 'Redis not configured (queue disabled, direct posting active)' }
    await conn.ping()
    return { ok: true, message: 'Redis connected' }
  } catch (err) {
    return { ok: false, message: `Redis unavailable (queue disabled): ${err.message}` }
  }
}

async function checkDiskSpace() {
  try {
    const { execSync } = require('child_process')
    const output = execSync('df -h / | tail -1', { timeout: 5000 }).toString()
    const parts = output.trim().split(/\s+/)
    const usagePercent = parseInt(parts[4]) || 0
    if (usagePercent > 90) {
      return { ok: false, message: `Disk ${usagePercent}% full — clean up logs!` }
    }
    return { ok: true, message: `Disk: ${usagePercent}% used` }
  } catch (err) {
    return { ok: true, message: 'Disk check skipped' }  // Non-critical
  }
}

function checkMemory() {
  const used = process.memoryUsage()
  const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024)
  const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024)
  const usagePercent = Math.round((used.heapUsed / used.heapTotal) * 100)

  if (usagePercent > 85) {
    // Try to free memory
    if (global.gc) {
      global.gc()
      logger.warn('[Health] High memory usage, ran GC')
    }
    return { ok: false, message: `Memory ${usagePercent}% (${heapUsedMB}/${heapTotalMB}MB)` }
  }
  return { ok: true, message: `Memory: ${heapUsedMB}MB/${heapTotalMB}MB (${usagePercent}%)` }
}

function checkSessions() {
  const fs = require('fs')
  const sessions = {
    facebook: './sessions/facebook_session.json',
    linkedin: './sessions/linkedin_session.json',
    twitter: './sessions/twitter_session.json',
  }

  const status = {}
  for (const [platform, path] of Object.entries(sessions)) {
    if (fs.existsSync(path)) {
      try {
        const stat = fs.statSync(path)
        const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60)
        // Warn if session is older than 7 days
        if (ageHours > 168) {
          status[platform] = `old (${Math.round(ageHours / 24)}d) — may need re-login`
        } else {
          status[platform] = `fresh (${Math.round(ageHours)}h old)`
        }
      } catch {
        status[platform] = 'unknown'
      }
    } else {
      status[platform] = 'not saved — will need login on first use'
    }
  }

  return { ok: true, message: 'Sessions checked', sessions: status }
}

function checkRecentActivity() {
  try {
    const database = db.getDb()
    const last24h = database.prepare(`
      SELECT COUNT(*) as count FROM post_logs
      WHERE posted_at > datetime('now', '-24 hours')
    `).get()

    const failed24h = database.prepare(`
      SELECT COUNT(*) as count FROM post_logs
      WHERE posted_at > datetime('now', '-24 hours') AND status = 'failed'
    `).get()

    const failRate = last24h.count > 0
      ? Math.round((failed24h.count / last24h.count) * 100)
      : 0

    if (failRate > 50 && last24h.count > 5) {
      return {
        ok: false,
        message: `High fail rate: ${failRate}% (${failed24h.count}/${last24h.count} posts failed in 24h)`
      }
    }

    return {
      ok: true,
      message: `24h activity: ${last24h.count} posts, ${failRate}% fail rate`
    }
  } catch (err) {
    return { ok: true, message: 'Activity check skipped' }
  }
}

// ─────────────────────────────────────────────────────────────────
// AUTO LOG CLEANUP
// Prevent logs folder from growing too big
// ─────────────────────────────────────────────────────────────────

function cleanupOldLogs() {
  const fs = require('fs')
  const path = require('path')
  const logDir = path.join(__dirname, '../../logs')

  if (!fs.existsSync(logDir)) return

  try {
    const files = fs.readdirSync(logDir)
    const now = Date.now()
    let cleaned = 0

    for (const file of files) {
      const filePath = path.join(logDir, file)
      const stat = fs.statSync(filePath)
      const ageDays = (now - stat.mtimeMs) / (1000 * 60 * 60 * 24)

      // Delete logs older than 30 days
      if (ageDays > 30) {
        fs.unlinkSync(filePath)
        cleaned++
      }

      // Truncate huge log files (> 50MB)
      if (stat.size > 50 * 1024 * 1024) {
        const content = fs.readFileSync(filePath, 'utf8')
        const lines = content.split('\n')
        const last1000Lines = lines.slice(-1000).join('\n')
        fs.writeFileSync(filePath, last1000Lines)
        logger.info(`[Health] Truncated log file ${file} (was ${Math.round(stat.size / 1024 / 1024)}MB)`)
      }
    }

    if (cleaned > 0) logger.info(`[Health] Cleaned ${cleaned} old log files`)
  } catch (err) {
    logger.warn(`[Health] Log cleanup failed: ${err.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────
// GET HEALTH STATUS (for API endpoint)
// ─────────────────────────────────────────────────────────────────

function getHealth() {
  return {
    upSince: health.upSince,
    lastChecked: health.lastChecked,
    uptime: Math.round(process.uptime()),
    pid: process.pid,
    nodeVersion: process.version,
    memory: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB',
    },
    status: health.status
  }
}

// ─────────────────────────────────────────────────────────────────
// START CRON JOBS
// ─────────────────────────────────────────────────────────────────

function startHealthCrons() {
  // Health check every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try { await checkAllSystems() } catch (e) {}
  })

  // Log cleanup every day at 3 AM
  cron.schedule('0 3 * * *', () => {
    try { cleanupOldLogs() } catch (e) {}
  })

  logger.info('Health monitor crons started ✅ (checks every 5 min)')
}

// Run initial check when imported
setTimeout(() => {
  checkAllSystems().catch(() => {})
}, 5000)

module.exports = {
  checkAllSystems,
  getHealth,
  startHealthCrons,
  cleanupOldLogs
}
