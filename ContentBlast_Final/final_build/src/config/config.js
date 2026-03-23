require('dotenv').config()

const config = {
  server: {
    port: parseInt(process.env.PORT) || 3000,
    env: process.env.NODE_ENV || 'development'
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || null
  },

  reddit: {
    clientId: process.env.REDDIT_CLIENT_ID || null,
    clientSecret: process.env.REDDIT_CLIENT_SECRET || null,
    username: process.env.REDDIT_USERNAME || null,
    password: process.env.REDDIT_PASSWORD || null,
    userAgent: process.env.REDDIT_USER_AGENT || 'ContentBlast/2.0'
  },

  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || null
  },

  facebook: {
    email: process.env.FACEBOOK_EMAIL || null,
    password: process.env.FACEBOOK_PASSWORD || null,
    sessionPath: './sessions/facebook_session.json'
  },

  linkedin: {
    email: process.env.LINKEDIN_EMAIL || null,
    password: process.env.LINKEDIN_PASSWORD || null,
    sessionPath: './sessions/linkedin_session.json'
  },

  twitter: {
    username: process.env.TWITTER_USERNAME || null,
    password: process.env.TWITTER_PASSWORD || null,
    phone: process.env.TWITTER_PHONE || null,
    sessionPath: './sessions/twitter_session.json'
  },

  whatsapp: {
    sessionPath: process.env.WHATSAPP_SESSION_PATH || './sessions/whatsapp'
  },

  ai: {
    ollamaEnabled: process.env.OLLAMA_ENABLED === 'true',
    ollamaModel: process.env.OLLAMA_MODEL || 'mistral',
    openaiKey: process.env.OPENAI_API_KEY || null
  },

  proxy: {
    list: process.env.PROXY_LIST
      ? process.env.PROXY_LIST.split(',').map(p => p.trim()).filter(Boolean)
      : [],
    useFree: process.env.USE_FREE_PROXIES === 'true'
  },

  antiSpam: {
    minDelay: parseInt(process.env.MIN_DELAY_BETWEEN_POSTS_MS) || 30000,
    maxDelay: parseInt(process.env.MAX_DELAY_BETWEEN_POSTS_MS) || 90000,
    maxPostsPerGroupPerDay: parseInt(process.env.MAX_POSTS_PER_GROUP_PER_DAY) || 1,
    maxPostsPerPlatformPerHour: parseInt(process.env.MAX_POSTS_PER_PLATFORM_PER_HOUR) || 5
  },

  scheduling: {
    enabled: process.env.ENABLE_BEST_TIME_SCHEDULING !== 'false',
    timezone: process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata'
  }
}

module.exports = config
