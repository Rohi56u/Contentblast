const axios = require('axios')
const logger = require('../config/logger')

// ─────────────────────────────────────────────────────────────────
// YOUTUBE LINK PROCESSOR
// Uses oEmbed API — No API key needed, 100% FREE
// ─────────────────────────────────────────────────────────────────

async function processYouTubeLink(url) {
  try {
    logger.info(`Processing YouTube URL: ${url}`)

    // Clean and validate YouTube URL
    const cleanUrl = cleanYouTubeUrl(url)
    if (!cleanUrl) throw new Error('Invalid YouTube URL')

    const videoId = extractYouTubeId(cleanUrl)
    if (!videoId) throw new Error('Could not extract YouTube video ID')

    // Fetch via oEmbed — FREE, no key needed
    const oEmbedRes = await axios.get(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(cleanUrl)}&format=json`,
      { timeout: 10000 }
    )

    const data = oEmbedRes.data

    // High quality thumbnail
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`

    const result = {
      platform: 'youtube',
      originalUrl: cleanUrl,
      shareUrl: `https://youtu.be/${videoId}`,
      videoId,
      title: data.title,
      channelName: data.author_name,
      channelUrl: data.author_url,
      thumbnailUrl,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      description: '' // oEmbed doesn't give description — optional
    }

    logger.info(`YouTube video fetched: "${result.title}"`)
    return result

  } catch (error) {
    logger.error(`YouTube processing failed: ${error.message}`)
    throw new Error(`YouTube link process failed: ${error.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────
// INSTAGRAM LINK PROCESSOR
// Uses oEmbed API — No API key needed
// ─────────────────────────────────────────────────────────────────

async function processInstagramLink(url) {
  try {
    logger.info(`Processing Instagram URL: ${url}`)

    const cleanUrl = cleanInstagramUrl(url)
    if (!cleanUrl) throw new Error('Invalid Instagram URL')

    // Try Instagram oEmbed
    try {
      const oEmbedRes = await axios.get(
        `https://api.instagram.com/oembed?url=${encodeURIComponent(cleanUrl)}`,
        { timeout: 10000 }
      )

      const data = oEmbedRes.data

      return {
        platform: 'instagram',
        originalUrl: cleanUrl,
        shareUrl: cleanUrl,
        title: data.title || `Instagram post by ${data.author_name}`,
        authorName: data.author_name,
        authorUrl: data.author_url,
        thumbnailUrl: data.thumbnail_url,
        description: data.title || ''
      }
    } catch (oembedErr) {
      // oEmbed failed — return basic info
      logger.warn('Instagram oEmbed failed, using basic info')
      const username = extractInstagramUsername(cleanUrl)
      return {
        platform: 'instagram',
        originalUrl: cleanUrl,
        shareUrl: cleanUrl,
        title: `Check out this Instagram post!`,
        authorName: username || 'Instagram Creator',
        thumbnailUrl: null,
        description: ''
      }
    }

  } catch (error) {
    logger.error(`Instagram processing failed: ${error.message}`)
    throw new Error(`Instagram link process failed: ${error.message}`)
  }
}

// ─────────────────────────────────────────────────────────────────
// MAIN PROCESSOR — Auto-detects platform
// ─────────────────────────────────────────────────────────────────

async function processLink(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('Valid URL required')
  }

  const trimmed = url.trim()

  if (isYouTubeUrl(trimmed)) {
    return await processYouTubeLink(trimmed)
  } else if (isInstagramUrl(trimmed)) {
    return await processInstagramLink(trimmed)
  } else {
    throw new Error('Only YouTube and Instagram URLs are supported')
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────

function isYouTubeUrl(url) {
  return /(?:youtube\.com|youtu\.be)/i.test(url)
}

function isInstagramUrl(url) {
  return /instagram\.com/i.test(url)
}

function cleanYouTubeUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'youtu.be') {
      return url  // Short URL, keep as is
    }
    if (parsed.hostname.includes('youtube.com')) {
      return url
    }
    return null
  } catch {
    return null
  }
}

function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([^&\n?#]+)/,
    /youtube\.com\/shorts\/([^&\n?#]+)/
  ]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]
  }
  return null
}

function cleanInstagramUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.includes('instagram.com')) {
      // Remove query params
      return `https://www.instagram.com${parsed.pathname}`
    }
    return null
  } catch {
    return null
  }
}

function extractInstagramUsername(url) {
  const match = url.match(/instagram\.com\/([^/?#]+)/)
  return match ? match[1] : null
}

module.exports = {
  processLink,
  processYouTubeLink,
  processInstagramLink,
  isYouTubeUrl,
  isInstagramUrl
}
