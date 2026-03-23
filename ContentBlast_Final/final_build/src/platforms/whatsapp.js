const { Client, LocalAuth } = require('whatsapp-web.js')
const qrcode = require('qrcode-terminal')
const config = require('../config/config')
const logger = require('../config/logger')
const rateLimiter = require('../core/rateLimit')

let waClient = null
let isReady = false
let qrCodeData = null
let initPromise = null
let reconnectTimer = null

// ─────────────────────────────────────────────────────────────────
// INITIALIZE — with auto-reconnect
// ─────────────────────────────────────────────────────────────────

async function initializeClient() {
  if (waClient && isReady) return waClient
  if (initPromise) return initPromise

  initPromise = new Promise((resolve, reject) => {
    waClient = new Client({
      authStrategy: new LocalAuth({
        dataPath: config.whatsapp?.sessionPath || './sessions/whatsapp'
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
      },
      // Auto-reconnect settings
      restartOnAuthFail: true,
      qrMaxRetries: 5,
    })

    const timeout = setTimeout(() => {
      reject(new Error('WhatsApp init timeout (120s) — scan QR code in terminal'))
      initPromise = null
    }, 120000)

    waClient.on('qr', (qr) => {
      qrCodeData = qr
      logger.info('WhatsApp QR Code — scan it:')
      qrcode.generate(qr, { small: true })
    })

    waClient.on('ready', () => {
      clearTimeout(timeout)
      isReady = true
      initPromise = null
      logger.info(`WhatsApp ready ✅ (${waClient.info?.wid?.user || 'connected'})`)
      resolve(waClient)
    })

    waClient.on('auth_failure', (msg) => {
      clearTimeout(timeout)
      isReady = false
      initPromise = null
      logger.error(`WhatsApp auth failed: ${msg}`)
      reject(new Error(`WhatsApp auth failed: ${msg}`))
    })

    waClient.on('disconnected', (reason) => {
      logger.warn(`WhatsApp disconnected: ${reason}`)
      isReady = false
      waClient = null
      initPromise = null

      // Auto-reconnect after 30 seconds
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => {
        logger.info('WhatsApp: Attempting auto-reconnect...')
        initializeClient().catch(err => logger.error(`WhatsApp reconnect failed: ${err.message}`))
      }, 30000)
    })

    waClient.initialize().catch(err => {
      clearTimeout(timeout)
      initPromise = null
      reject(err)
    })
  })

  return initPromise
}

// ─────────────────────────────────────────────────────────────────
// POST TO GROUP
// ─────────────────────────────────────────────────────────────────

async function postToGroup(groupId, message) {
  const canPost = await rateLimiter.waitUntilAllowed('whatsapp', groupId, 3 * 60 * 1000)
  if (!canPost) throw new Error(`Rate limit: skipping WhatsApp group ${groupId}`)

  const wClient = await initializeClient()
  const chat = await wClient.getChatById(groupId)

  if (!chat) throw new Error(`WhatsApp group ${groupId} not found`)
  if (!chat.isGroup) throw new Error(`${groupId} is not a group`)

  const text = typeof message === 'object' ? (message.text || '') : message
  await chat.sendMessage(text.slice(0, 4000))

  rateLimiter.recordPost('whatsapp', groupId)
  logger.info(`WhatsApp ✅ ${chat.name || groupId}`)
  return { success: true }
}

// ─────────────────────────────────────────────────────────────────
// DISTRIBUTE TO MULTIPLE GROUPS
// ─────────────────────────────────────────────────────────────────

async function distributeToGroups(groups, message, onProgress) {
  const results = []

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]

    try {
      await postToGroup(group.group_id, message)
      results.push({ groupId: group.id, groupName: group.group_name, status: 'success' })
      if (onProgress) onProgress({ group, status: 'success', index: i, total: groups.length })
    } catch (error) {
      results.push({ groupId: group.id, groupName: group.group_name, status: 'failed', error: error.message })
      if (onProgress) onProgress({ group, status: 'failed', error: error.message, index: i, total: groups.length })
    }

    if (i < groups.length - 1) {
      const delay = rateLimiter.getSmartDelay('whatsapp')
      logger.info(`WhatsApp: Waiting ${(delay / 1000).toFixed(0)}s...`)
      await sleep(delay)
    }
  }

  return results
}

async function getAllGroups() {
  try {
    const wClient = await initializeClient()
    const chats = await wClient.getChats()
    return chats.filter(c => c.isGroup).map(c => ({
      id: c.id._serialized,
      name: c.name,
      participants: c.participants?.length || 0
    }))
  } catch (err) {
    logger.error(`WhatsApp getAllGroups failed: ${err.message}`)
    return []
  }
}

async function testConnection() {
  try {
    const wClient = await initializeClient()
    if (isReady) return { success: true, number: wClient.info?.wid?.user || 'connected' }
    return { success: false, error: 'Not ready — scan QR code' }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function getQrCode() { return qrCodeData }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = { initializeClient, postToGroup, distributeToGroups, getAllGroups, testConnection, getQrCode }
