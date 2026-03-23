const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const logger = require('../config/logger')

const DB_PATH = path.join(__dirname, '../../data/distributor.db')

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH)
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

let db

function getDb() {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')  // Better performance
    db.pragma('foreign_keys = ON')
    setupTables()
    logger.info('Database connected ✅')
  }
  return db
}

function setupTables() {
  const database = db

  // ─── GROUPS TABLE ────────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id            TEXT PRIMARY KEY,
      platform      TEXT NOT NULL,
      group_id      TEXT NOT NULL,
      group_name    TEXT NOT NULL,
      niche         TEXT DEFAULT 'general',
      group_url     TEXT,
      active        INTEGER DEFAULT 1,
      last_posted   TEXT,
      total_posts   INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now'))
    )
  `)

  // ─── POST LOGS TABLE ─────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS post_logs (
      id            TEXT PRIMARY KEY,
      video_url     TEXT NOT NULL,
      video_title   TEXT,
      platform      TEXT NOT NULL,
      group_id      TEXT NOT NULL,
      group_name    TEXT,
      status        TEXT DEFAULT 'pending',
      error_msg     TEXT,
      posted_at     TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    )
  `)

  // ─── CAMPAIGNS TABLE ─────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id            TEXT PRIMARY KEY,
      youtube_url   TEXT,
      instagram_url TEXT,
      video_title   TEXT,
      thumbnail_url TEXT,
      description   TEXT,
      status        TEXT DEFAULT 'pending',
      total_groups  INTEGER DEFAULT 0,
      posted_count  INTEGER DEFAULT 0,
      failed_count  INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now')),
      completed_at  TEXT
    )
  `)

  // ─── SESSIONS TABLE ──────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS platform_sessions (
      platform      TEXT PRIMARY KEY,
      session_data  TEXT,
      last_updated  TEXT DEFAULT (datetime('now'))
    )
  `)

  logger.info('Database tables ready ✅')
}

// ─────────────────────────────────────────────────────────────────
// GROUP OPERATIONS
// ─────────────────────────────────────────────────────────────────

function addGroup(group) {
  const database = getDb()
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO groups 
    (id, platform, group_id, group_name, niche, group_url, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `)
  const id = `${group.platform}_${group.group_id}`
  stmt.run(id, group.platform, group.group_id, group.group_name, group.niche || 'general', group.group_url || null)
  return id
}

function getActiveGroups(platform = null, niche = null) {
  const database = getDb()
  let query = 'SELECT * FROM groups WHERE active = 1'
  const params = []

  if (platform) {
    query += ' AND platform = ?'
    params.push(platform)
  }
  if (niche) {
    query += ' AND niche = ?'
    params.push(niche)
  }

  return database.prepare(query).all(...params)
}

function updateGroupLastPosted(groupId) {
  const database = getDb()
  database.prepare(`
    UPDATE groups 
    SET last_posted = datetime('now'), total_posts = total_posts + 1
    WHERE id = ?
  `).run(groupId)
}

function wasPostedToGroupToday(groupId, videoUrl) {
  const database = getDb()
  const result = database.prepare(`
    SELECT COUNT(*) as count FROM post_logs
    WHERE group_id = ? AND video_url = ?
    AND date(posted_at) = date('now')
    AND status = 'success'
  `).get(groupId, videoUrl)
  return result.count > 0
}

// ─────────────────────────────────────────────────────────────────
// CAMPAIGN OPERATIONS
// ─────────────────────────────────────────────────────────────────

function createCampaign(data) {
  const database = getDb()
  const { v4: uuidv4 } = require('uuid')
  const id = uuidv4()

  database.prepare(`
    INSERT INTO campaigns
    (id, youtube_url, instagram_url, video_title, thumbnail_url, description, status, total_groups)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
  `).run(
    id,
    data.youtubeUrl || null,
    data.instagramUrl || null,
    data.title || 'Untitled',
    data.thumbnailUrl || null,
    data.description || null,
    data.totalGroups || 0
  )

  return id
}

function updateCampaignProgress(campaignId, status, postedCount, failedCount) {
  const database = getDb()
  const completedAt = status === 'completed' ? "datetime('now')" : 'NULL'
  database.prepare(`
    UPDATE campaigns
    SET status = ?, posted_count = ?, failed_count = ?, 
        completed_at = ${status === 'completed' ? "datetime('now')" : 'NULL'}
    WHERE id = ?
  `).run(status, postedCount, failedCount, campaignId)
}

function getCampaigns(limit = 20) {
  const database = getDb()
  return database.prepare(`
    SELECT * FROM campaigns ORDER BY created_at DESC LIMIT ?
  `).all(limit)
}

function getCampaignById(id) {
  const database = getDb()
  return database.prepare('SELECT * FROM campaigns WHERE id = ?').get(id)
}

// ─────────────────────────────────────────────────────────────────
// POST LOG OPERATIONS
// ─────────────────────────────────────────────────────────────────

function logPost(data) {
  const database = getDb()
  const { v4: uuidv4 } = require('uuid')
  const id = uuidv4()

  database.prepare(`
    INSERT INTO post_logs
    (id, video_url, video_title, platform, group_id, group_name, status, error_msg, posted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id,
    data.videoUrl,
    data.videoTitle || null,
    data.platform,
    data.groupId,
    data.groupName || null,
    data.status,
    data.errorMsg || null
  )
}

function getPostLogs(campaignId = null, limit = 50) {
  const database = getDb()
  if (campaignId) {
    return database.prepare(`
      SELECT * FROM post_logs WHERE video_url IN 
      (SELECT youtube_url FROM campaigns WHERE id = ?)
      ORDER BY created_at DESC LIMIT ?
    `).all(campaignId, limit)
  }
  return database.prepare(`
    SELECT * FROM post_logs ORDER BY created_at DESC LIMIT ?
  `).all(limit)
}

function getStats() {
  const database = getDb()
  return {
    totalGroups: database.prepare('SELECT COUNT(*) as c FROM groups WHERE active = 1').get().c,
    totalCampaigns: database.prepare('SELECT COUNT(*) as c FROM campaigns').get().c,
    totalPosts: database.prepare("SELECT COUNT(*) as c FROM post_logs WHERE status = 'success'").get().c,
    totalFailed: database.prepare("SELECT COUNT(*) as c FROM post_logs WHERE status = 'failed'").get().c,
    platformBreakdown: database.prepare(`
      SELECT platform, COUNT(*) as count FROM post_logs 
      WHERE status = 'success' GROUP BY platform
    `).all()
  }
}

module.exports = {
  getDb,
  addGroup,
  getActiveGroups,
  updateGroupLastPosted,
  wasPostedToGroupToday,
  createCampaign,
  updateCampaignProgress,
  getCampaigns,
  getCampaignById,
  logPost,
  getPostLogs,
  getStats
}
