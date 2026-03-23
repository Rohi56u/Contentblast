const TelegramBot = require('node-telegram-bot-api')
const config = require('../config/config')
const logger = require('../config/logger')
const { retryTelegram } = require('../core/retryWithBackoff')
const rateLimiter = require('../core/rateLimit')

let bot = null

function getBot() {
  if (!bot) {
    if (!config.telegram?.botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN not set in .env')
    }
    bot = new TelegramBot(config.telegram.botToken, { polling: false })
    logger.info('Telegram bot initialized ✅')
  }
  return bot
}

// ─────────────────────────────────────────────────────────────────
// POST TO SINGLE GROUP — with retry + rate limit
// ─────────────────────────────────────────────────────────────────

async function postToGroup(chatId, caption, thumbnailUrl = null) {
  const telegramBot = getBot()

  // Check rate limit before posting
  const canPost = await rateLimiter.waitUntilAllowed('telegram', chatId, 5 * 60 * 1000)
  if (!canPost) {
    throw new Error(`Rate limit: skipping Telegram group ${chatId}`)
  }

  return retryTelegram(async () => {
    // Handle Telegram flood wait errors
    try {
      let message

      if (thumbnailUrl) {
        try {
          message = await telegramBot.sendPhoto(chatId, thumbnailUrl, {
            caption: safeCaption(caption.text),
            parse_mode: 'Markdown'
          })
        } catch (photoErr) {
          // Photo failed → fallback to plain text with link preview
          logger.warn(`Telegram: Photo send failed, falling back to text: ${photoErr.message}`)
          message = await telegramBot.sendMessage(chatId, safeCaption(caption.text), {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
          })
        }
      } else {
        message = await telegramBot.sendMessage(chatId, safeCaption(caption.text), {
          parse_mode: 'Markdown',
          disable_web_page_preview: false
        })
      }

      rateLimiter.recordPost('telegram', chatId)
      logger.info(`Telegram ✅ ${chatId} (msg: ${message.message_id})`)
      return { success: true, messageId: message.message_id }

    } catch (err) {
      // Handle Telegram-specific errors
      if (err.message?.includes('parse')) {
        // Markdown parse error → retry without formatting
        logger.warn(`Telegram: Markdown error for ${chatId}, retrying as plain text`)
        const rawText = (caption.text || '').replace(/[*_`\[\]]/g, '')
        const message = await telegramBot.sendMessage(chatId, rawText, {
          disable_web_page_preview: false
        })
        rateLimiter.recordPost('telegram', chatId)
        return { success: true, messageId: message.message_id }
      }

      // Flood wait
      if (err.message?.includes('Flood')) {
        const match = err.message.match(/retry after (\d+)/)
        if (match) {
          const secs = parseInt(match[1])
          rateLimiter.setFloodWait('telegram', secs)
          const waitErr = new Error(`Flood wait ${secs}s`)
          waitErr.code = 'FLOOD_WAIT'
          throw waitErr
        }
      }

      throw err
    }
  }, chatId)
}

// ─────────────────────────────────────────────────────────────────
// DISTRIBUTE TO MULTIPLE GROUPS
// ─────────────────────────────────────────────────────────────────

async function distributeToGroups(groups, caption, thumbnailUrl, onProgress) {
  const results = []

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]

    try {
      const result = await postToGroup(group.group_id, caption, thumbnailUrl)
      results.push({ groupId: group.id, groupName: group.group_name, status: 'success', ...result })
      if (onProgress) onProgress({ group, status: 'success', index: i, total: groups.length })
    } catch (error) {
      results.push({ groupId: group.id, groupName: group.group_name, status: 'failed', error: error.message })
      if (onProgress) onProgress({ group, status: 'failed', error: error.message, index: i, total: groups.length })
    }

    if (i < groups.length - 1) {
      const delay = rateLimiter.getSmartDelay('telegram')
      logger.info(`Telegram: Waiting ${(delay / 1000).toFixed(1)}s...`)
      await sleep(delay)
    }
  }

  return results
}

async function testConnection() {
  try {
    const b = getBot()
    const me = await b.getMe()
    return { success: true, botName: me.first_name, username: me.username }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// Safely escape Markdown to prevent parse errors
function safeCaption(text) {
  if (!text) return ''
  // If markdown looks malformed, strip it
  const asteriskCount = (text.match(/\*/g) || []).length
  if (asteriskCount % 2 !== 0) return text.replace(/[*_`\[\]]/g, '')
  return text
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = { postToGroup, distributeToGroups, testConnection }
