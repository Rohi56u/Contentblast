const winston = require('winston')
const path = require('path')

const logDir = path.join(__dirname, '../../logs')

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : ''
      return `[${timestamp}] ${level.toUpperCase()} → ${message} ${metaStr}`
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${timestamp}] ${level} → ${message}`
        })
      )
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error'
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log')
    })
  ]
})

// Create logs dir if not exists
const fs = require('fs')
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })

module.exports = logger
