const { v4: uuidv4 } = require('uuid')
const db = require('../database/db')
const logger = require('../config/logger')

// ─────────────────────────────────────────────────────────────────
// UTM ANALYTICS ENGINE
//
// Kya karta hai:
// 1. Har group ke liye unique tracking link banata hai
// 2. Track karta hai kahan se views aaye
// 3. Best performing groups identify karta hai
// 4. Reports generate karta hai
//
// Example:
// youtu.be/abc → youtu.be/abc?utm_source=telegram&utm_medium=group&utm_campaign=grp_tech_01
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// SETUP UTM TRACKING TABLE IN DB
// ─────────────────────────────────────────────────────────────────

function setupAnalyticsTables() {
  const database = db.getDb()

  database.exec(`
    CREATE TABLE IF NOT EXISTS utm_links (
      id            TEXT PRIMARY KEY,
      campaign_id   TEXT,
      video_url     TEXT NOT NULL,
      platform      TEXT NOT NULL,
      group_id      TEXT NOT NULL,
      group_name    TEXT,
      utm_url       TEXT NOT NULL,
      utm_campaign  TEXT,
      clicks        INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now'))
    )
  `)

  database.exec(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id            TEXT PRIMARY KEY,
      utm_link_id   TEXT,
      platform      TEXT,
      group_id      TEXT,
      event_type    TEXT,
      metadata      TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    )
  `)

  logger.info('Analytics tables ready ✅')
}

// ─────────────────────────────────────────────────────────────────
// GENERATE UTM TRACKING URL
// ─────────────────────────────────────────────────────────────────

function generateUTMUrl(videoUrl, platform, groupId, groupName, campaignId) {
  try {
    const url = new URL(videoUrl)

    // Clean group name for UTM
    const cleanGroupName = (groupName || groupId)
      .replace(/[^a-zA-Z0-9]/g, '_')
      .toLowerCase()
      .slice(0, 30)

    // UTM parameters
    url.searchParams.set('utm_source', platform)
    url.searchParams.set('utm_medium', 'group_post')
    url.searchParams.set('utm_campaign', `cb_${cleanGroupName}`)
    url.searchParams.set('utm_content', campaignId ? campaignId.slice(0, 8) : 'manual')

    const utmUrl = url.toString()

    // Save to DB
    const database = db.getDb()
    const id = uuidv4()

    database.prepare(`
      INSERT OR REPLACE INTO utm_links
      (id, campaign_id, video_url, platform, group_id, group_name, utm_url, utm_campaign)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, campaignId || null, videoUrl, platform, groupId, groupName || null, utmUrl, `cb_${cleanGroupName}`)

    return utmUrl

  } catch (err) {
    logger.warn(`UTM generation failed for ${videoUrl}: ${err.message}`)
    return videoUrl  // Fallback to original URL
  }
}

// ─────────────────────────────────────────────────────────────────
// GENERATE UTM URLS FOR ALL GROUPS IN A CAMPAIGN
// ─────────────────────────────────────────────────────────────────

function generateCampaignUTMUrls(videoUrl, groups, campaignId) {
  const urlMap = {}

  for (const group of groups) {
    urlMap[group.id] = generateUTMUrl(
      videoUrl,
      group.platform,
      group.group_id || group.id,
      group.group_name || group.name,
      campaignId
    )
  }

  return urlMap
}

// ─────────────────────────────────────────────────────────────────
// GET ANALYTICS REPORT
// ─────────────────────────────────────────────────────────────────

function getAnalyticsReport(campaignId = null, days = 30) {
  const database = db.getDb()

  // Platform performance breakdown
  const platformStats = database.prepare(`
    SELECT
      ul.platform,
      COUNT(ul.id) as total_links,
      SUM(ul.clicks) as total_clicks,
      ROUND(AVG(ul.clicks), 1) as avg_clicks
    FROM utm_links ul
    WHERE (? IS NULL OR ul.campaign_id = ?)
    AND ul.created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY ul.platform
    ORDER BY total_clicks DESC
  `).all(campaignId, campaignId, days)

  // Top performing groups
  const topGroups = database.prepare(`
    SELECT
      ul.group_name,
      ul.platform,
      ul.clicks,
      ul.utm_url,
      ul.created_at
    FROM utm_links ul
    WHERE (? IS NULL OR ul.campaign_id = ?)
    AND ul.created_at >= datetime('now', '-' || ? || ' days')
    ORDER BY ul.clicks DESC
    LIMIT 10
  `).all(campaignId, campaignId, days)

  // Daily post volume
  const dailyVolume = database.prepare(`
    SELECT
      date(created_at) as date,
      COUNT(*) as posts,
      SUM(clicks) as clicks
    FROM utm_links
    WHERE created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY date(created_at)
    ORDER BY date DESC
    LIMIT 30
  `).all(days)

  // Campaign summary if provided
  let campaignSummary = null
  if (campaignId) {
    campaignSummary = database.prepare(`
      SELECT
        c.*,
        COUNT(ul.id) as tracked_links,
        SUM(ul.clicks) as total_tracked_clicks
      FROM campaigns c
      LEFT JOIN utm_links ul ON ul.campaign_id = c.id
      WHERE c.id = ?
      GROUP BY c.id
    `).get(campaignId)
  }

  return {
    platformStats,
    topGroups,
    dailyVolume,
    campaignSummary,
    generatedAt: new Date().toISOString()
  }
}

// ─────────────────────────────────────────────────────────────────
// TRACK CLICK (Manual tracking endpoint)
// Call this if you have a redirect server
// ─────────────────────────────────────────────────────────────────

function trackClick(utmLinkId) {
  try {
    const database = db.getDb()
    database.prepare('UPDATE utm_links SET clicks = clicks + 1 WHERE id = ?').run(utmLinkId)

    database.prepare(`
      INSERT INTO analytics_events (id, utm_link_id, event_type)
      VALUES (?, ?, 'click')
    `).run(uuidv4(), utmLinkId)

  } catch (err) {
    logger.error(`Click tracking failed: ${err.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────
// GET ALL UTM LINKS for a video
// ─────────────────────────────────────────────────────────────────

function getUTMLinks(videoUrl = null, campaignId = null) {
  const database = db.getDb()

  if (campaignId) {
    return database.prepare(`
      SELECT * FROM utm_links WHERE campaign_id = ? ORDER BY platform, group_name
    `).all(campaignId)
  }

  if (videoUrl) {
    return database.prepare(`
      SELECT * FROM utm_links WHERE video_url = ? ORDER BY platform
    `).all(videoUrl)
  }

  return database.prepare(`
    SELECT * FROM utm_links ORDER BY created_at DESC LIMIT 100
  `).all()
}

// ─────────────────────────────────────────────────────────────────
// BEST PERFORMING GROUPS (for smart targeting)
// Returns groups sorted by historical click performance
// ─────────────────────────────────────────────────────────────────

function getBestPerformingGroups(platform = null, limit = 20) {
  const database = db.getDb()

  let query = `
    SELECT
      g.*,
      COALESCE(SUM(ul.clicks), 0) as total_clicks,
      COALESCE(COUNT(ul.id), 0) as total_posts,
      CASE WHEN COUNT(ul.id) > 0
        THEN ROUND(SUM(ul.clicks) * 1.0 / COUNT(ul.id), 2)
        ELSE 0
      END as avg_clicks_per_post
    FROM groups g
    LEFT JOIN utm_links ul ON ul.group_id = g.group_id AND ul.platform = g.platform
    WHERE g.active = 1
  `

  const params = []
  if (platform) {
    query += ' AND g.platform = ?'
    params.push(platform)
  }

  query += `
    GROUP BY g.id
    ORDER BY avg_clicks_per_post DESC, total_clicks DESC
    LIMIT ?
  `
  params.push(limit)

  return database.prepare(query).all(...params)
}

// Initialize tables on import
try { setupAnalyticsTables() } catch (e) {}

module.exports = {
  generateUTMUrl,
  generateCampaignUTMUrls,
  getAnalyticsReport,
  trackClick,
  getUTMLinks,
  getBestPerformingGroups
}
