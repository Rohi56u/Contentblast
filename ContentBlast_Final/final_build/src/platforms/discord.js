const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js')
const config = require('../config/config')
const logger = require('../config/logger')
const { retryDiscord } = require('../core/retryWithBackoff')
const rateLimiter = require('../core/rateLimit')

let client = null
let isReady = false
let connectPromise = null

// ─────────────────────────────────────────────────────────────────
// GET CLIENT — singleton with auto-reconnect
// ─────────────────────────────────────────────────────────────────

async function getClient() {
  if (client && isReady) return client

  // Prevent multiple simultaneous connection attempts
  if (connectPromise) return connectPromise

  connectPromise = new Promise((resolve, reject) => {
    if (!config.discord?.botToken) {
      reject(new Error('DISCORD_BOT_TOKEN not set in .env'))
      connectPromise = null
      return
    }

    // Destroy old client if exists
    if (client) {
      try { client.destroy() } catch (e) {}
      client = null
      isReady = false
    }

    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    })

    const timeout = setTimeout(() => {
      reject(new Error('Discord login timeout (30s)'))
      connectPromise = null
    }, 30000)

    client.once('ready', () => {
      clearTimeout(timeout)
      isReady = true
      connectPromise = null
      logger.info(`Discord bot ready: ${client.user.tag} ✅`)
      resolve(client)
    })

    client.once('error', (err) => {
      clearTimeout(timeout)
      isReady = false
      connectPromise = null
      reject(err)
    })

    // Auto-reconnect on disconnect
    client.on('disconnect', () => {
      logger.warn('Discord disconnected — will reconnect on next use')
      isReady = false
      client = null
    })

    client.login(config.discord.botToken).catch(err => {
      clearTimeout(timeout)
      connectPromise = null
      reject(err)
    })
  })

  return connectPromise
}

// ─────────────────────────────────────────────────────────────────
// POST TO CHANNEL — with retry + rate limit
// ─────────────────────────────────────────────────────────────────

async function postToChannel(channelId, caption) {
  const canPost = await rateLimiter.waitUntilAllowed('discord', channelId, 2 * 60 * 1000)
  if (!canPost) throw new Error(`Rate limit: skipping Discord channel ${channelId}`)

  return retryDiscord(async () => {
    const discordClient = await getClient()
    const channel = await discordClient.channels.fetch(channelId)

    if (!channel) throw new Error(`Channel ${channelId} not found`)
    if (!channel.isTextBased()) throw new Error(`Channel ${channelId} is not text-based`)

    let message

    if (caption?.embeds) {
      const embeds = caption.embeds.map(e => {
        const embed = new EmbedBuilder()
          .setTitle((e.title || '').slice(0, 256))
          .setURL(e.url || '')
          .setColor(e.color || 0x7c3aed)
          .setTimestamp()
          .setFooter({ text: 'ContentBlast' })

        if (e.description) embed.setDescription(e.description.slice(0, 4096))
        if (e.author?.name) embed.setAuthor({ name: e.author.name.slice(0, 256) })
        if (e.thumbnail?.url) {
          try { embed.setThumbnail(e.thumbnail.url) } catch (e) {}
        }
        return embed
      })

      message = await channel.send({ content: caption.content || '', embeds })
    } else {
      const text = caption?.text || caption || ''
      message = await channel.send({ content: text.slice(0, 2000) })
    }

    rateLimiter.recordPost('discord', channelId)
    logger.info(`Discord ✅ #${channel.name || channelId} (msg: ${message.id})`)
    return { success: true, messageId: message.id }
  }, channelId)
}

// ─────────────────────────────────────────────────────────────────
// DISTRIBUTE TO MULTIPLE CHANNELS
// ─────────────────────────────────────────────────────────────────

async function distributeToChannels(groups, caption, onProgress) {
  const results = []

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]

    try {
      const result = await postToChannel(group.group_id, caption)
      results.push({ groupId: group.id, groupName: group.group_name, status: 'success', ...result })
      if (onProgress) onProgress({ group, status: 'success', index: i, total: groups.length })
    } catch (error) {
      results.push({ groupId: group.id, groupName: group.group_name, status: 'failed', error: error.message })
      if (onProgress) onProgress({ group, status: 'failed', error: error.message, index: i, total: groups.length })
    }

    if (i < groups.length - 1) {
      const delay = rateLimiter.getSmartDelay('discord')
      await sleep(delay)
    }
  }

  return results
}

async function testConnection() {
  try {
    const c = await getClient()
    return { success: true, botTag: c.user.tag }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

async function destroy() {
  if (client) {
    try { await client.destroy() } catch (e) {}
    client = null
    isReady = false
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = { postToChannel, distributeToChannels, testConnection, destroy }
