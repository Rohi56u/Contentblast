const Snoowrap = require('snoowrap')
const axios = require('axios')
const config = require('../config/config')
const logger = require('../config/logger')

// ─────────────────────────────────────────────────────────────────
// REDDIT AUTO DISCOVERY
// Keyword se relevant subreddits dhundho
// ─────────────────────────────────────────────────────────────────

async function discoverRedditGroups(keywords, limit = 15) {
  try {
    if (!config.reddit.clientId) {
      logger.warn('Reddit credentials not set, skipping discovery')
      return []
    }

    const reddit = new Snoowrap({
      userAgent: config.reddit.userAgent,
      clientId: config.reddit.clientId,
      clientSecret: config.reddit.clientSecret,
      username: config.reddit.username,
      password: config.reddit.password
    })

    const results = []
    const seen = new Set()

    // Search for each keyword
    for (const keyword of keywords) {
      try {
        const subs = await reddit.searchSubreddits({ query: keyword, limit: 10 })

        for (const sub of subs) {
          if (seen.has(sub.display_name)) continue
          seen.add(sub.display_name)

          // Filter: min 1000 subscribers, not NSFW, not banned
          if (sub.subscribers < 1000) continue
          if (sub.over18) continue
          if (!sub.public_description && !sub.description) continue

          results.push({
            platform: 'reddit',
            id: sub.display_name,              // e.g. "technology"
            name: `r/${sub.display_name}`,
            members: sub.subscribers,
            description: (sub.public_description || '').slice(0, 120),
            url: `https://reddit.com/r/${sub.display_name}`,
            active_users: sub.active_user_count || 0,
            score: calculateScore(sub.subscribers, sub.active_user_count)
          })
        }
      } catch (err) {
        logger.warn(`Reddit search failed for "${keyword}": ${err.message}`)
      }

      await sleep(1000) // Rate limit
    }

    // Sort by score (best first)
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)

  } catch (error) {
    logger.error(`Reddit discovery failed: ${error.message}`)
    return []
  }
}

// ─────────────────────────────────────────────────────────────────
// TELEGRAM AUTO DISCOVERY
// Uses Telegram's public search — no API key needed
// ─────────────────────────────────────────────────────────────────

async function discoverTelegramGroups(keywords, limit = 15) {
  try {
    const results = []
    const seen = new Set()

    for (const keyword of keywords) {
      // Method 1: tgstat.com (public group directory)
      try {
        const tgstatResults = await searchTgStat(keyword)
        for (const g of tgstatResults) {
          if (!seen.has(g.id)) {
            seen.add(g.id)
            results.push(g)
          }
        }
      } catch (err) {
        logger.warn(`TGStat search failed for "${keyword}": ${err.message}`)
      }

      // Method 2: telegram-group.com directory
      try {
        const dirResults = await searchTelegramDirectory(keyword)
        for (const g of dirResults) {
          if (!seen.has(g.id)) {
            seen.add(g.id)
            results.push(g)
          }
        }
      } catch (err) {
        logger.warn(`TG Directory search failed for "${keyword}": ${err.message}`)
      }

      await sleep(1500)
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)

  } catch (error) {
    logger.error(`Telegram discovery failed: ${error.message}`)
    return []
  }
}

// Search tgstat.com — biggest Telegram group directory
async function searchTgStat(keyword) {
  try {
    const res = await axios.get(`https://tgstat.com/en/search`, {
      params: { q: keyword, type: 'group' },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 10000
    })

    const cheerio = require('cheerio')
    const $ = cheerio.load(res.data)
    const groups = []

    // Parse tgstat search results
    $('.peer-item-box').each((i, el) => {
      try {
        const name = $(el).find('.peer-title').text().trim()
        const username = $(el).find('.peer-username').text().trim().replace('@', '')
        const membersText = $(el).find('.members-count').text().trim()
        const members = parseMemberCount(membersText)
        const desc = $(el).find('.peer-description').text().trim().slice(0, 120)

        if (!username || members < 500) return

        groups.push({
          platform: 'telegram',
          id: `@${username}`,
          name: name || `@${username}`,
          members,
          description: desc,
          url: `https://t.me/${username}`,
          score: calculateScore(members, 0)
        })
      } catch { /* skip */ }
    })

    return groups

  } catch (err) {
    return []
  }
}

// Search telegram-group.com
async function searchTelegramDirectory(keyword) {
  try {
    const res = await axios.get(`https://www.telegram-group.com/en/search/`, {
      params: { q: keyword },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    })

    const cheerio = require('cheerio')
    const $ = cheerio.load(res.data)
    const groups = []

    $('.card').each((i, el) => {
      try {
        const name = $(el).find('.card-title').text().trim()
        const link = $(el).find('a').attr('href') || ''
        const membersText = $(el).find('.badge').text().trim()
        const members = parseMemberCount(membersText)
        const desc = $(el).find('.card-text').text().trim().slice(0, 120)

        // Extract username from t.me link
        const usernameMatch = link.match(/t\.me\/([^/?]+)/)
        if (!usernameMatch) return

        const username = usernameMatch[1]
        if (members < 200) return

        groups.push({
          platform: 'telegram',
          id: `@${username}`,
          name: name || `@${username}`,
          members,
          description: desc,
          url: `https://t.me/${username}`,
          score: calculateScore(members, 0)
        })
      } catch { /* skip */ }
    })

    return groups

  } catch (err) {
    return []
  }
}

// ─────────────────────────────────────────────────────────────────
// MAIN DISCOVERY FUNCTION
// Call this from API — discovers from both platforms
// ─────────────────────────────────────────────────────────────────

async function discoverGroups({ keywords, platforms = ['reddit', 'telegram'], limit = 20 }) {
  logger.info(`Discovering groups for keywords: [${keywords.join(', ')}]`)

  const allResults = []

  // Run both in parallel
  const tasks = []

  if (platforms.includes('reddit')) {
    tasks.push(
      discoverRedditGroups(keywords, limit)
        .then(r => allResults.push(...r))
        .catch(e => logger.error(`Reddit discovery error: ${e.message}`))
    )
  }

  if (platforms.includes('telegram')) {
    tasks.push(
      discoverTelegramGroups(keywords, limit)
        .then(r => allResults.push(...r))
        .catch(e => logger.error(`Telegram discovery error: ${e.message}`))
    )
  }

  await Promise.all(tasks)

  // Deduplicate and sort
  const seen = new Set()
  const unique = allResults.filter(g => {
    if (seen.has(g.id)) return false
    seen.add(g.id)
    return true
  })

  unique.sort((a, b) => b.score - a.score)

  logger.info(`Discovered ${unique.length} groups total`)
  return unique
}

// ─────────────────────────────────────────────────────────────────
// KEYWORD EXTRACTOR
// Auto keywords from video title
// ─────────────────────────────────────────────────────────────────

function extractKeywords(title, niche) {
  const keywords = []

  // Niche-based keywords
  const nicheKeywords = {
    tech: ['technology', 'programming', 'coding', 'software', 'developer'],
    gaming: ['gaming', 'games', 'gamer', 'videogames', 'esports'],
    finance: ['finance', 'investing', 'stocks', 'crypto', 'money'],
    fitness: ['fitness', 'gym', 'workout', 'health', 'bodybuilding'],
    food: ['food', 'cooking', 'recipe', 'foodie', 'chef'],
    travel: ['travel', 'wanderlust', 'backpacking', 'adventure'],
    education: ['education', 'learning', 'students', 'study', 'knowledge'],
    entertainment: ['entertainment', 'funny', 'comedy', 'viral', 'memes'],
    business: ['entrepreneur', 'business', 'startup', 'marketing', 'hustle'],
    general: ['viral', 'trending', 'youtube', 'content']
  }

  // Add niche keywords
  if (niche && nicheKeywords[niche]) {
    keywords.push(...nicheKeywords[niche].slice(0, 3))
  }

  // Extract from title (remove common words)
  const stopWords = new Set(['the','a','an','and','or','but','in','on','at','to','for',
    'of','with','by','from','is','was','are','be','this','that','how','what','why','when'])

  const titleWords = title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w))
    .slice(0, 3)

  keywords.push(...titleWords)

  // Deduplicate
  return [...new Set(keywords)].slice(0, 5)
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function calculateScore(members, activeUsers) {
  // Score based on size + activity
  const memberScore = Math.log10(members + 1) * 100
  const activityScore = activeUsers ? Math.log10(activeUsers + 1) * 50 : 0
  return Math.round(memberScore + activityScore)
}

function parseMemberCount(text) {
  if (!text) return 0
  const clean = text.replace(/,/g, '').toLowerCase()
  if (clean.includes('m')) return parseFloat(clean) * 1000000
  if (clean.includes('k')) return parseFloat(clean) * 1000
  return parseInt(clean) || 0
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

module.exports = {
  discoverGroups,
  discoverRedditGroups,
  discoverTelegramGroups,
  extractKeywords
}
