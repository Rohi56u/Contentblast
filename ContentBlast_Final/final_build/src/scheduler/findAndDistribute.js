const { discoverGroups, extractKeywords } = require('../discovery/groupDiscovery')
const { processLink } = require('../processors/linkProcessor')
const { generateCaptions } = require('../caption/captionEngine')
const { generateAllAICaptions } = require('../caption/aiCaption')
const { generateCampaignUTMUrls } = require('../analytics/utm')
const telegramPlatform = require('../platforms/telegram')
const redditPlatform = require('../platforms/reddit')
const db = require('../database/db')
const logger = require('../config/logger')
const rateLimiter = require('../core/rateLimit')

// ─────────────────────────────────────────────────────────────────
// FIND & DISTRIBUTE
// Auto-discovers groups → user selects → posts
// Fully bulletproof — every step has fallback
// ─────────────────────────────────────────────────────────────────

async function findAndDistribute(params, onProgress) {
  const {
    youtubeUrl, instagramUrl,
    niche = 'general',
    autoSelect = false,
    maxGroups = 20,
    selectedGroupIds = null
  } = params

  // ── STEP 1: Process Link ─────────────────────────────────────
  notify(onProgress, { type: 'status', message: '🔗 Processing your link...' })

  let videoData
  try {
    videoData = await processLink(youtubeUrl || instagramUrl)
    videoData.youtubeUrl = youtubeUrl || null
    videoData.instagramUrl = instagramUrl || null
    if (youtubeUrl) videoData.shareUrl = youtubeUrl
    notify(onProgress, { type: 'link_processed', message: `✅ "${videoData.title}"`, videoData })
  } catch (err) {
    logger.error(`Link failed: ${err.message}`)
    return { success: false, error: `Could not process link: ${err.message}` }
  }

  // ── STEP 2: Extract Keywords ─────────────────────────────────
  const keywords = extractKeywords(videoData.title, niche)
  notify(onProgress, { type: 'keywords', message: `🔑 Keywords: ${keywords.join(', ')}`, keywords })

  // ── STEP 3: Discover Groups ──────────────────────────────────
  notify(onProgress, { type: 'status', message: '🔍 Searching for relevant groups...' })

  let discoveredGroups = []
  try {
    discoveredGroups = await discoverGroups({ keywords, platforms: ['reddit', 'telegram'], limit: maxGroups })
  } catch (err) {
    logger.error(`Discovery failed: ${err.message}`)
    notify(onProgress, { type: 'status', message: `⚠️ Discovery error: ${err.message}` })
  }

  if (discoveredGroups.length === 0) {
    return { success: false, error: 'No groups found. Try different niche or add custom keywords.' }
  }

  notify(onProgress, { type: 'groups_found', message: `📍 Found ${discoveredGroups.length} groups!`, groups: discoveredGroups })

  // ── STEP 4: If no selection yet, return for user choice ──────
  if (!autoSelect && !selectedGroupIds) {
    return {
      success: true,
      stage: 'discovery_complete',
      videoData, keywords, groups: discoveredGroups,
      message: 'Select groups and post!'
    }
  }

  // ── STEP 5: Filter to selected ───────────────────────────────
  let groupsToPost = discoveredGroups
  if (selectedGroupIds?.length > 0) {
    groupsToPost = discoveredGroups.filter(g => selectedGroupIds.includes(g.id))
  }
  if (groupsToPost.length === 0) {
    return { success: false, error: 'No valid groups in your selection.' }
  }

  // ── STEP 6: Captions (AI → template fallback) ────────────────
  notify(onProgress, { type: 'status', message: '✍️ Generating captions...' })
  let captions
  try {
    captions = await generateAllAICaptions(videoData, niche) || generateCaptions(videoData, niche)
  } catch (err) {
    captions = generateCaptions(videoData, niche)
  }

  // ── STEP 7: Create Campaign + UTM ────────────────────────────
  let campaignId
  try {
    campaignId = db.createCampaign({
      youtubeUrl: videoData.youtubeUrl, instagramUrl: videoData.instagramUrl,
      title: videoData.title, thumbnailUrl: videoData.thumbnailUrl,
      totalGroups: groupsToPost.length
    })
  } catch (e) { campaignId = 'temp-' + Date.now() }

  let utmUrls = {}
  try { utmUrls = generateCampaignUTMUrls(videoData.shareUrl, groupsToPost, campaignId) } catch (e) {}

  notify(onProgress, { type: 'campaign_started', campaignId, total: groupsToPost.length, message: `🚀 Posting to ${groupsToPost.length} groups...` })

  // ── STEP 8: Post to Each Group ───────────────────────────────
  const results = []
  let posted = 0, failed = 0

  for (let i = 0; i < groupsToPost.length; i++) {
    const group = groupsToPost[i]
    const trackUrl = utmUrls[group.id] || videoData.shareUrl
    const caption = buildCaptionWithUTM(captions, group.platform, trackUrl)

    try {
      if (group.platform === 'reddit') {
        await redditPlatform.postToSubreddit(group.id, caption)
      } else if (group.platform === 'telegram') {
        await telegramPlatform.postToGroup(group.id, caption, videoData.thumbnailUrl)
      }

      try {
        db.logPost({ videoUrl: videoData.shareUrl, videoTitle: videoData.title, platform: group.platform, groupId: group.id, groupName: group.name, status: 'success' })
      } catch (e) {}

      results.push({ ...group, status: 'success' })
      posted++
      notify(onProgress, { type: 'post_success', message: `✅ [${group.platform.toUpperCase()}] ${group.name}`, group, index: i, total: groupsToPost.length, posted, failed })

    } catch (err) {
      try {
        db.logPost({ videoUrl: videoData.shareUrl, videoTitle: videoData.title, platform: group.platform, groupId: group.id, groupName: group.name, status: 'failed', errorMsg: err.message })
      } catch (e) {}

      results.push({ ...group, status: 'failed', error: err.message })
      failed++
      notify(onProgress, { type: 'post_failed', message: `❌ [${group.platform.toUpperCase()}] ${group.name}`, group, index: i, total: groupsToPost.length, posted, failed })
    }

    // Smart delay between posts
    if (i < groupsToPost.length - 1) {
      const delay = rateLimiter.getSmartDelay(group.platform)
      notify(onProgress, { type: 'waiting', message: `⏳ Waiting ${Math.round(delay / 1000)}s...`, delayMs: delay })
      await sleep(delay)
    }
  }

  // ── STEP 9: Finalize ─────────────────────────────────────────
  try { db.updateCampaignProgress(campaignId, 'completed', posted, failed) } catch (e) {}

  const summary = { success: true, stage: 'completed', campaignId, videoTitle: videoData.title, totalFound: discoveredGroups.length, totalPosted: posted, totalFailed: failed, results }
  notify(onProgress, { type: 'completed', message: `🎉 Done! ${posted} posted, ${failed} failed.`, ...summary })
  return summary
}

// Inject UTM URL into caption
function buildCaptionWithUTM(captions, platform, utmUrl) {
  const cap = captions[platform] || captions.telegram
  if (!utmUrl || !cap) return cap

  if (typeof cap === 'object' && cap.text) {
    return { ...cap, text: cap.text.replace(/https?:\/\/[^\s]+/, utmUrl) }
  }
  if (typeof cap === 'object' && cap.title) {
    return { ...cap, text: utmUrl }
  }
  if (typeof cap === 'string') {
    return cap.replace(/https?:\/\/[^\s]+/, utmUrl)
  }
  return cap
}

function notify(cb, data) {
  if (typeof cb === 'function') try { cb(data) } catch (e) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = { findAndDistribute }
