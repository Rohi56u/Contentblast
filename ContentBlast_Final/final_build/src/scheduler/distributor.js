const { processLink } = require('../processors/linkProcessor')
const { generateCaptions } = require('../caption/captionEngine')
const { generateAllAICaptions } = require('../caption/aiCaption')
const { generateCampaignUTMUrls } = require('../analytics/utm')
const telegramPlatform = require('../platforms/telegram')
const redditPlatform = require('../platforms/reddit')
const discordPlatform = require('../platforms/discord')
const facebookPlatform = require('../platforms/facebook')
const whatsappPlatform = require('../platforms/whatsapp')
const linkedinPlatform = require('../platforms/linkedin')
const twitterPlatform = require('../platforms/twitter')
const db = require('../database/db')
const logger = require('../config/logger')

// ─────────────────────────────────────────────────────────────────
// MANUAL DISTRIBUTOR — posts to saved DB groups
// Supports 7 platforms, AI captions, UTM tracking
// Fully graceful: one platform failing doesn't stop others
// ─────────────────────────────────────────────────────────────────

async function runDistribution(params, onProgress) {
  const { youtubeUrl, instagramUrl, selectedPlatforms, niche = 'general' } = params

  logger.info('🚀 Starting distribution campaign...')

  // ── STEP 1: Process Link ─────────────────────────────────────
  let videoData
  try {
    const url = youtubeUrl || instagramUrl
    videoData = await processLink(url)
    videoData.youtubeUrl = youtubeUrl || null
    videoData.instagramUrl = instagramUrl || null
    if (youtubeUrl) videoData.shareUrl = youtubeUrl
    notify(onProgress, { type: 'link_processed', videoData })
    logger.info(`Video: "${videoData.title}"`)
  } catch (err) {
    logger.error(`Link processing failed: ${err.message}`)
    return { success: false, error: `Could not process link: ${err.message}` }
  }

  // ── STEP 2: Generate Captions ────────────────────────────────
  let captions
  try {
    captions = await generateAllAICaptions(videoData, niche) || generateCaptions(videoData, niche)
  } catch (err) {
    logger.warn(`Caption generation error, using templates: ${err.message}`)
    captions = generateCaptions(videoData, niche)
  }

  // ── STEP 3: Get Eligible Groups from DB ──────────────────────
  const platforms = selectedPlatforms || ['telegram', 'reddit', 'discord', 'facebook', 'whatsapp', 'linkedin', 'twitter']
  const allGroups = {}
  let totalGroups = 0

  for (const platform of platforms) {
    try {
      const groups = db.getActiveGroups(platform)
      const eligible = groups.filter(g => !db.wasPostedToGroupToday(g.id, videoData.shareUrl))
      allGroups[platform] = eligible
      totalGroups += eligible.length
      if (eligible.length > 0) logger.info(`${platform}: ${eligible.length} groups`)
    } catch (err) {
      logger.error(`Error loading groups for ${platform}: ${err.message}`)
      allGroups[platform] = []
    }
  }

  if (totalGroups === 0) {
    return { success: false, error: 'No eligible groups. Add groups via dashboard or all already posted today.' }
  }

  // ── STEP 4: Create Campaign ──────────────────────────────────
  let campaignId
  try {
    campaignId = db.createCampaign({
      youtubeUrl: videoData.youtubeUrl,
      instagramUrl: videoData.instagramUrl,
      title: videoData.title,
      thumbnailUrl: videoData.thumbnailUrl,
      description: videoData.description,
      totalGroups
    })
  } catch (err) {
    logger.warn(`Campaign creation failed: ${err.message}`)
    campaignId = 'temp-' + Date.now()
  }

  // UTM tracking URLs
  let utmUrls = {}
  try {
    const flat = Object.values(allGroups).flat()
    utmUrls = generateCampaignUTMUrls(videoData.shareUrl, flat, campaignId)
  } catch (err) {
    logger.warn(`UTM generation failed: ${err.message}`)
  }

  notify(onProgress, { type: 'campaign_created', campaignId, totalGroups })

  let totalPosted = 0
  let totalFailed = 0
  const allResults = []

  // Progress callback
  const progressCb = (platform) => ({ group, status, error, index, total }) => {
    try {
      db.logPost({
        videoUrl: videoData.shareUrl,
        videoTitle: videoData.title,
        platform,
        groupId: group.id,
        groupName: group.group_name,
        status,
        errorMsg: error || null
      })
      if (status === 'success') { db.updateGroupLastPosted(group.id); totalPosted++ }
      else totalFailed++
      db.updateCampaignProgress(campaignId, 'running', totalPosted, totalFailed)
    } catch (e) {}
    notify(onProgress, { type: 'post_result', platform, group, status, error, index, total })
  }

  // ── STEP 5: Post to each platform (each isolated) ────────────

  const platformTasks = [
    {
      name: 'telegram', emoji: '✈️',
      run: (groups) => telegramPlatform.distributeToGroups(groups, captions.telegram, videoData.thumbnailUrl, progressCb('telegram'))
    },
    {
      name: 'discord', emoji: '🎮',
      run: (groups) => discordPlatform.distributeToChannels(groups, captions.discord, progressCb('discord'))
    },
    {
      name: 'reddit', emoji: '🔴',
      run: (groups) => redditPlatform.distributeToSubreddits(groups, captions.reddit, progressCb('reddit'))
    },
    {
      name: 'whatsapp', emoji: '💬',
      run: (groups) => whatsappPlatform.distributeToGroups(groups, captions.whatsapp?.text || captions.whatsapp, progressCb('whatsapp'))
    },
    {
      name: 'facebook', emoji: '📘',
      run: (groups) => facebookPlatform.distributeToGroups(groups, captions.facebook?.text || captions.facebook, progressCb('facebook'))
    },
    {
      name: 'linkedin', emoji: '💼',
      run: (groups) => linkedinPlatform.distributeToGroups(groups, captions.linkedin?.text || captions.linkedin, videoData, progressCb('linkedin'))
    },
    {
      name: 'twitter', emoji: '🐦',
      run: async (groups) => {
        const tweetText = twitterPlatform.buildTweetText(videoData, niche)
        const result = await twitterPlatform.postTweet(tweetText)
        if (result.success) {
          groups.forEach(g => progressCb('twitter')({ group: g, status: 'success', index: 0, total: groups.length }))
          return groups.map(g => ({ ...g, status: 'success' }))
        }
        return []
      }
    }
  ]

  for (const task of platformTasks) {
    const groups = allGroups[task.name]
    if (!groups?.length) continue

    logger.info(`${task.emoji} Posting to ${groups.length} ${task.name} groups...`)

    try {
      const results = await task.run(groups)
      if (results) allResults.push(...results)
    } catch (err) {
      // One platform fails → log it, continue with others
      logger.error(`${task.name} platform error: ${err.message}`)
      notify(onProgress, { type: 'platform_error', platform: task.name, error: err.message })
      groups.forEach(g => allResults.push({ groupId: g.id, groupName: g.group_name, platform: task.name, status: 'failed', error: err.message }))
    }
  }

  // ── STEP 6: Finalize ─────────────────────────────────────────
  try {
    db.updateCampaignProgress(campaignId, 'completed', totalPosted, totalFailed)
  } catch (e) {}

  const summary = {
    success: true,
    campaignId,
    videoTitle: videoData.title,
    totalGroups,
    totalPosted,
    totalFailed,
    results: allResults
  }

  logger.info(`✅ Done: ${totalPosted}/${totalGroups} success, ${totalFailed} failed`)
  notify(onProgress, { type: 'campaign_completed', ...summary })
  return summary
}

function notify(cb, data) {
  if (typeof cb === 'function') try { cb(data) } catch (e) {}
}

module.exports = { runDistribution }
