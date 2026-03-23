require('dotenv').config()
const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')

const config = require('../config/config')
const logger = require('../config/logger')
const routes = require('./routes')

// Ensure dirs exist
const root = path.join(__dirname, '../../')
;['data', 'sessions', 'logs', 'sessions/whatsapp'].forEach(d => {
  const full = path.join(root, d)
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true })
})

const app = express()

// CORS — allow file:// too so dashboard/index.html works when opened directly
app.use(cors({
  origin: (origin, cb) => cb(null, true),  // Allow all origins
  credentials: true
}))

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Request logger (skip health check spam)
app.use((req, res, next) => {
  if (req.path !== '/api/health') logger.info(`${req.method} ${req.path}`)
  next()
})

// API routes
app.use('/api', routes)

// Serve dashboard
const dashboardDist = path.join(root, 'dashboard/dist')
const dashboardFile = path.join(root, 'dashboard/index.html')

if (fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist))
  app.get('*', (req, res) => res.sendFile(path.join(dashboardDist, 'index.html')))
} else if (fs.existsSync(dashboardFile)) {
  app.get('/', (req, res) => res.sendFile(dashboardFile))
} else {
  app.get('/', (req, res) => res.json({ message: 'ContentBlast v2 API', dashboard: 'Open dashboard/index.html in browser' }))
}

// Global error handler — server never crashes from a bad request
app.use((err, req, res, next) => {
  logger.error(`API error: ${err.message}`)
  res.status(500).json({ success: false, error: err.message })
})

const PORT = config.server?.port || 3000

const server = app.listen(PORT, () => {
  logger.info(`
╔══════════════════════════════════════════════════╗
║       🚀 ContentBlast v2.0 Started               ║
║       http://localhost:${PORT}                     ║
║  Open dashboard/index.html in your browser       ║
╚══════════════════════════════════════════════════╝`)

  // Start health monitor + scheduler after boot
  setTimeout(() => {
    try { require('../core/healthMonitor').startHealthCrons() } catch (e) {}
    if (config.scheduling?.enabled !== false) {
      try { require('../analytics/bestTimeScheduler').startSchedulerCron() } catch (e) {}
    }
  }, 3000)
})

// Keep-alive
server.keepAliveTimeout = 65000
server.headersTimeout = 66000

// Graceful shutdown
async function shutdown(sig) {
  logger.info(`${sig} — shutting down gracefully...`)
  server.close()
  try { const d = require('../platforms/discord'); await d.destroy() } catch (e) {}
  try { const { closeAll } = require('../queue/queueManager'); await closeAll() } catch (e) {}
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// Never crash on unhandled errors — PM2 handles restarts
process.on('uncaughtException', (err) => {
  logger.error(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`)
  // Don't exit — PM2 will restart if needed
})

process.on('unhandledRejection', (reason) => {
  logger.error(`UNHANDLED REJECTION: ${reason}`)
})

module.exports = app
