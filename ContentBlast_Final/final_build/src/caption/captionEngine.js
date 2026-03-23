// ─────────────────────────────────────────────────────────────────
// CAPTION ENGINE
// Platform-wise captions generate karta hai
// No AI API needed — smart template system
// ─────────────────────────────────────────────────────────────────

const logger = require('../config/logger')

// Common hashtag sets by niche
const NICHE_HASHTAGS = {
  tech: '#tech #technology #coding #programming #developer #softwareengineering #techupdates',
  gaming: '#gaming #gamer #videogames #gameplay #twitch #youtube #games',
  finance: '#finance #investing #money #stocks #crypto #wealth #financetips',
  fitness: '#fitness #gym #workout #health #motivation #fitnessmotivation',
  food: '#food #foodie #recipe #cooking #delicious #yummy #foodblogger',
  travel: '#travel #wanderlust #explore #adventure #traveling #travelgram',
  education: '#education #learning #study #knowledge #students #teaching',
  entertainment: '#entertainment #viral #trending #funny #comedy',
  business: '#business #entrepreneur #startup #success #marketing #hustl',
  general: '#youtube #video #viral #trending #mustwatch #content'
}

// Emoji sets for different moods
const EMOJIS = {
  fire: '🔥',
  point: '👉',
  eyes: '👀',
  star: '⭐',
  rocket: '🚀',
  check: '✅',
  video: '🎥',
  clap: '👏',
  wave: '👋',
  mind: '🤯',
  gem: '💎',
  link: '🔗'
}

function generateCaptions(videoData, niche = 'general') {
  const { title, shareUrl, channelName, platform, description } = videoData
  const hashtags = NICHE_HASHTAGS[niche] || NICHE_HASHTAGS.general
  const shortDesc = description ? description.slice(0, 120) + '...' : ''

  // Source label
  const sourceLabel = platform === 'youtube' ? 'YouTube' : 'Instagram'
  const sourceName = channelName ? `by ${channelName}` : ''

  return {

    // ── TELEGRAM ──────────────────────────────────────────────────
    telegram: buildTelegramCaption({ title, shareUrl, channelName, shortDesc, hashtags, sourceLabel }),

    // ── FACEBOOK ──────────────────────────────────────────────────
    facebook: buildFacebookCaption({ title, shareUrl, channelName, shortDesc, niche }),

    // ── REDDIT ────────────────────────────────────────────────────
    reddit: {
      title: `${title}${channelName ? ` (${channelName})` : ''}`,
      text: shareUrl
    },

    // ── DISCORD ───────────────────────────────────────────────────
    discord: buildDiscordCaption(videoData, shortDesc),

    // ── WHATSAPP ──────────────────────────────────────────────────
    whatsapp: buildWhatsAppCaption({ title, shareUrl, channelName, hashtags })
  }
}

// ─────────────────────────────────────────────────────────────────

function buildTelegramCaption({ title, shareUrl, channelName, shortDesc, hashtags }) {
  const lines = []
  lines.push(`${EMOJIS.video} *${escapeMarkdown(title)}*`)
  lines.push('')
  if (channelName) lines.push(`${EMOJIS.star} Channel: ${escapeMarkdown(channelName)}`)
  if (shortDesc) lines.push(`${shortDesc}`)
  lines.push('')
  lines.push(`${EMOJIS.point} Watch here: ${shareUrl}`)
  lines.push('')
  lines.push(hashtags)

  return {
    text: lines.join('\n'),
    parseMode: 'Markdown'
  }
}

function buildFacebookCaption({ title, shareUrl, channelName, shortDesc, niche }) {
  const openers = [
    `${EMOJIS.fire} Don't miss this!`,
    `${EMOJIS.eyes} You need to watch this!`,
    `${EMOJIS.rocket} Check this out!`,
    `${EMOJIS.gem} Must watch video!`
  ]
  const opener = openers[Math.floor(Math.random() * openers.length)]

  const lines = []
  lines.push(opener)
  lines.push('')
  lines.push(`📺 ${title}`)
  if (channelName) lines.push(`👤 ${channelName}`)
  if (shortDesc) lines.push(`\n${shortDesc}`)
  lines.push('')
  lines.push(`${EMOJIS.link} ${shareUrl}`)
  lines.push('')
  lines.push(`Drop a comment if you found this helpful ${EMOJIS.clap}`)

  return lines.join('\n')
}

function buildDiscordCaption(videoData, shortDesc) {
  const { title, shareUrl, channelName, thumbnailUrl, platform } = videoData

  return {
    content: `${EMOJIS.fire} **New video alert!**`,
    embeds: [{
      title: title,
      url: shareUrl,
      description: shortDesc || `Check out this amazing ${platform === 'youtube' ? 'YouTube' : 'Instagram'} video!`,
      color: platform === 'youtube' ? 0xFF0000 : 0xE1306C,  // Red for YT, Pink for IG
      author: channelName ? { name: channelName } : undefined,
      thumbnail: thumbnailUrl ? { url: thumbnailUrl } : undefined,
      footer: { text: `Shared via ContentDistributor` },
      timestamp: new Date().toISOString()
    }]
  }
}

function buildWhatsAppCaption({ title, shareUrl, channelName, hashtags }) {
  const lines = []
  lines.push(`*${EMOJIS.fire} ${title}*`)
  lines.push('')
  if (channelName) lines.push(`_By ${channelName}_`)
  lines.push('')
  lines.push(`${EMOJIS.point} ${shareUrl}`)

  return lines.join('\n')
}

// Escape special chars for Telegram Markdown
function escapeMarkdown(text) {
  if (!text) return ''
  return text.replace(/[*_`\[\]()~>#+=|{}.!-]/g, '\\$&')
}

// Get captions for a specific platform only
function getCaptionForPlatform(videoData, platform, niche = 'general') {
  const all = generateCaptions(videoData, niche)
  return all[platform] || all.telegram
}

module.exports = {
  generateCaptions,
  getCaptionForPlatform
}
