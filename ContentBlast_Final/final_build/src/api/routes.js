const express = require('express')
const router = express.Router()
const { v4: uuidv4 } = require('uuid')

const { findAndDistribute } = require('../scheduler/findAndDistribute')
const { runDistribution } = require('../scheduler/distributor')
const { discoverGroups, extractKeywords } = require('../discovery/groupDiscovery')
const { processLink } = require('../processors/linkProcessor')
const { getQueueStats, clearFailed } = require('../queue/queueManager')
const { getAnalyticsReport, getUTMLinks, getBestPerformingGroups } = require('../analytics/utm')
const { getScheduledPosts, getPeakTimes } = require('../analytics/bestTimeScheduler')
const { checkAIStatus } = require('../caption/aiCaption')
const { getHealth } = require('../core/healthMonitor')
const proxyManager = require('../anti-ban/proxyManager')
const rateLimiter = require('../core/rateLimit')
const db = require('../database/db')
const logger = require('../config/logger')

// Platform handlers
const telegramPlatform = require('../platforms/telegram')
const redditPlatform = require('../platforms/reddit')
const discordPlatform = require('../platforms/discord')
const whatsappPlatform = require('../platforms/whatsapp')
const linkedinPlatform = require('../platforms/linkedin')
const twitterPlatform = require('../platforms/twitter')

const sseClients = new Map()

function sendSSE(id, data) {
  const c = sseClients.get(id)
  if (c) try { c.write(`data: ${JSON.stringify(data)}\n\n`) } catch (e) {}
}

function closeSSE(id) {
  const c = sseClients.get(id)
  if (c) try { c.end() } catch (e) {}
  sseClients.delete(id)
}

// ── HEALTH ─────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  try {
    const h = getHealth()
    res.json({ status: 'ok', ...h })
  } catch (e) {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  }
})

// ── PREVIEW LINK ───────────────────────────────────────────────
router.post('/preview', async (req, res) => {
  try {
    const { url } = req.body
    if (!url) return res.status(400).json({ error: 'URL required' })
    const data = await processLink(url.trim())
    res.json({ success: true, data })
  } catch (err) {
    res.status(400).json({ success: false, error: err.message })
  }
})

// ── DISCOVER GROUPS ────────────────────────────────────────────
router.post('/discover', async (req, res) => {
  try {
    const { keywords, niche, videoTitle, platforms, limit = 20 } = req.body
    const finalKws = keywords?.length > 0 ? keywords
      : videoTitle ? extractKeywords(videoTitle, niche)
      : [niche || 'general', 'video']

    const groups = await discoverGroups({
      keywords: finalKws,
      platforms: platforms || ['reddit', 'telegram'],
      limit: Math.min(parseInt(limit) || 20, 50)
    })
    res.json({ success: true, keywords: finalKws, total: groups.length, groups })
  } catch (err) {
    logger.error(`Discover: ${err.message}`)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ── FIND & DISTRIBUTE ──────────────────────────────────────────
router.post('/find-and-distribute', async (req, res) => {
  try {
    const { youtubeUrl, instagramUrl, niche, selectedGroupIds, autoSelect } = req.body
    if (!youtubeUrl && !instagramUrl) return res.status(400).json({ error: 'URL required' })

    const sessionId = uuidv4()
    res.json({ success: true, sessionId })

    findAndDistribute(
      { youtubeUrl, instagramUrl, niche, selectedGroupIds, autoSelect },
      (d) => sendSSE(sessionId, d)
    ).then(r => { sendSSE(sessionId, { type: 'done', ...r }); closeSSE(sessionId) })
     .catch(e => { sendSSE(sessionId, { type: 'error', error: e.message }); closeSSE(sessionId) })

  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ── MANUAL DISTRIBUTE ──────────────────────────────────────────
router.post('/distribute', async (req, res) => {
  try {
    const { youtubeUrl, instagramUrl, selectedPlatforms, niche } = req.body
    if (!youtubeUrl && !instagramUrl) return res.status(400).json({ error: 'URL required' })

    const sessionId = uuidv4()
    res.json({ success: true, sessionId })

    runDistribution(
      { youtubeUrl, instagramUrl, selectedPlatforms, niche },
      (d) => sendSSE(sessionId, d)
    ).then(r => { sendSSE(sessionId, { type: 'done', ...r }); closeSSE(sessionId) })
     .catch(e => { sendSSE(sessionId, { type: 'error', error: e.message }); closeSSE(sessionId) })

  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ── SSE STREAM ─────────────────────────────────────────────────
router.get('/stream/:id', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  sseClients.set(req.params.id, res)
  const ping = setInterval(() => { try { res.write(': ping\n\n') } catch (e) {} }, 15000)
  req.on('close', () => { clearInterval(ping); sseClients.delete(req.params.id) })
})

// ── GROUPS CRUD ────────────────────────────────────────────────
router.get('/groups', (req, res) => {
  try {
    res.json({ success: true, groups: db.getActiveGroups(req.query.platform || null) })
  } catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

router.post('/groups', (req, res) => {
  try {
    const { platform, group_id, group_name, niche, group_url } = req.body
    if (!platform || !group_id || !group_name) return res.status(400).json({ error: 'platform, group_id, group_name required' })
    const id = db.addGroup({ platform, group_id, group_name, niche, group_url })
    res.json({ success: true, id })
  } catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

router.delete('/groups/:id', (req, res) => {
  try {
    db.getDb().prepare('UPDATE groups SET active = 0 WHERE id = ?').run(req.params.id)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

router.get('/groups/best', (req, res) => {
  try { res.json({ success: true, groups: getBestPerformingGroups(req.query.platform || null) }) }
  catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

// ── CAMPAIGNS ──────────────────────────────────────────────────
router.get('/campaigns', (req, res) => {
  try { res.json({ success: true, campaigns: db.getCampaigns(30) }) }
  catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

router.get('/campaigns/:id', (req, res) => {
  try {
    const campaign = db.getCampaignById(req.params.id)
    const logs = db.getPostLogs(req.params.id)
    const utmLinks = getUTMLinks(null, req.params.id)
    res.json({ success: true, campaign, logs, utmLinks })
  } catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

// ── STATS ──────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  try { res.json({ success: true, stats: db.getStats() }) }
  catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

// ── ANALYTICS ─────────────────────────────────────────────────
router.get('/analytics', (req, res) => {
  try {
    const report = getAnalyticsReport(req.query.campaignId || null, parseInt(req.query.days) || 30)
    res.json({ success: true, report })
  } catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

// ── QUEUE ──────────────────────────────────────────────────────
router.get('/queue/stats', async (req, res) => {
  try { res.json({ success: true, ...(await getQueueStats()) }) }
  catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

router.delete('/queue/failed/:platform', async (req, res) => {
  try { await clearFailed(req.params.platform); res.json({ success: true }) }
  catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

// ── SCHEDULING ─────────────────────────────────────────────────
router.get('/scheduled', (req, res) => {
  try { res.json({ success: true, posts: getScheduledPosts(req.query.status || 'pending') }) }
  catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

router.get('/schedule/peak-times', (req, res) => {
  try { res.json({ success: true, peakTimes: getPeakTimes() }) }
  catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

// ── AI STATUS ──────────────────────────────────────────────────
router.get('/ai/status', async (req, res) => {
  try { res.json({ success: true, status: await checkAIStatus() }) }
  catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

// ── PROXY ──────────────────────────────────────────────────────
router.get('/proxy/stats', (req, res) => {
  try { res.json({ success: true, stats: proxyManager.getStats() }) }
  catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

router.post('/proxy/reload', async (req, res) => {
  try {
    const proxies = await proxyManager.loadProxies()
    res.json({ success: true, total: proxies.length, working: proxies.filter(p => p.working).length })
  } catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

// ── RATE LIMIT STATS ───────────────────────────────────────────
router.get('/ratelimit/stats', (req, res) => {
  try { res.json({ success: true, stats: rateLimiter.getStats() }) }
  catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

// ── PLATFORM CONNECTIONS ───────────────────────────────────────
router.get('/connections', async (req, res) => {
  const results = {}
  const tests = [
    { name: 'telegram', fn: () => telegramPlatform.testConnection() },
    { name: 'reddit', fn: () => redditPlatform.testConnection() },
    { name: 'discord', fn: () => discordPlatform.testConnection() },
    { name: 'whatsapp', fn: () => whatsappPlatform.testConnection() },
    { name: 'linkedin', fn: () => linkedinPlatform.testConnection() },
    { name: 'twitter', fn: () => twitterPlatform.testConnection() },
  ]

  for (const t of tests) {
    try {
      results[t.name] = await Promise.race([
        t.fn(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))
      ])
    } catch (e) {
      results[t.name] = { success: false, error: e.message }
    }
  }

  res.json({ success: true, connections: results })
})

router.get('/whatsapp/qr', (req, res) => {
  const qr = whatsappPlatform.getQrCode?.() || null
  res.json({ success: true, qr, message: qr ? 'Scan in WhatsApp' : 'Already connected or not initialized' })
})

router.get('/logs', (req, res) => {
  try { res.json({ success: true, logs: db.getPostLogs(null, parseInt(req.query.limit) || 50) }) }
  catch (err) { res.status(500).json({ success: false, error: err.message }) }
})

module.exports = router
