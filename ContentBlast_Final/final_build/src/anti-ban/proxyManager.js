const axios = require('axios')
const logger = require('../config/logger')

// ─────────────────────────────────────────────────────────────────
// PROXY MANAGER
// Rotates proxies to avoid IP bans
// Especially important for Facebook/Instagram Playwright automation
//
// FREE PROXY SOURCES:
// 1. Free public proxies (unreliable but zero cost)
// 2. Your own proxy list in .env
//
// PAID (better):
// - Webshare.io ($5/month, 100 proxies)
// - Oxylabs, Brightdata (more expensive)
// ─────────────────────────────────────────────────────────────────

class ProxyManager {
  constructor() {
    this.proxies = []
    this.currentIndex = 0
    this.failedProxies = new Set()
    this.lastRefresh = null
    this.REFRESH_INTERVAL = 30 * 60 * 1000  // Refresh every 30 minutes
  }

  // ── LOAD PROXIES ────────────────────────────────────────────

  async loadProxies() {
    this.proxies = []

    // 1. Load from .env (highest priority)
    if (process.env.PROXY_LIST) {
      const envProxies = process.env.PROXY_LIST.split(',').map(p => p.trim()).filter(Boolean)
      this.proxies.push(...envProxies.map(p => ({ url: p, source: 'env', working: true })))
      logger.info(`Loaded ${envProxies.length} proxies from .env`)
    }

    // 2. Fetch free proxies from public sources
    if (this.proxies.length === 0 || process.env.USE_FREE_PROXIES === 'true') {
      const freeProxies = await this.fetchFreeProxies()
      this.proxies.push(...freeProxies)
    }

    // 3. Test all proxies
    if (this.proxies.length > 0) {
      await this.testAllProxies()
    }

    this.lastRefresh = Date.now()
    const workingCount = this.proxies.filter(p => p.working).length
    logger.info(`Proxy pool: ${workingCount}/${this.proxies.length} working proxies`)
    return this.proxies
  }

  // ── FETCH FREE PUBLIC PROXIES ────────────────────────────────

  async fetchFreeProxies() {
    const proxies = []

    // Source 1: free-proxy-list.net API
    try {
      const res = await axios.get('https://proxylist.geonode.com/api/proxy-list?limit=50&page=1&sort_by=lastChecked&sort_type=desc&filterUpTime=90&protocols=http%2Chttps', {
        timeout: 10000
      })

      if (res.data?.data) {
        for (const p of res.data.data.slice(0, 30)) {
          proxies.push({
            url: `${p.protocols[0]}://${p.ip}:${p.port}`,
            country: p.country,
            source: 'geonode',
            working: null
          })
        }
        logger.info(`Fetched ${proxies.length} free proxies from GeoNode`)
      }
    } catch (err) {
      logger.warn(`GeoNode proxy fetch failed: ${err.message}`)
    }

    return proxies
  }

  // ── TEST PROXY ───────────────────────────────────────────────

  async testProxy(proxy) {
    try {
      await axios.get('https://httpbin.org/ip', {
        proxy: {
          host: this.extractHost(proxy.url),
          port: this.extractPort(proxy.url),
          protocol: this.extractProtocol(proxy.url)
        },
        timeout: 8000
      })
      return true
    } catch {
      return false
    }
  }

  async testAllProxies() {
    logger.info(`Testing ${this.proxies.length} proxies...`)
    const tests = this.proxies.map(async (proxy) => {
      proxy.working = await this.testProxy(proxy)
      return proxy
    })
    await Promise.allSettled(tests)
    const working = this.proxies.filter(p => p.working).length
    logger.info(`${working} proxies working out of ${this.proxies.length}`)
  }

  // ── GET NEXT PROXY ───────────────────────────────────────────

  async getProxy() {
    // Auto-refresh proxies every 30 min
    if (!this.lastRefresh || Date.now() - this.lastRefresh > this.REFRESH_INTERVAL) {
      await this.loadProxies()
    }

    const working = this.proxies.filter(p => p.working && !this.failedProxies.has(p.url))
    if (working.length === 0) {
      logger.warn('No working proxies available — posting without proxy')
      return null
    }

    // Round-robin rotation
    const proxy = working[this.currentIndex % working.length]
    this.currentIndex++
    return proxy
  }

  // ── MARK PROXY FAILED ────────────────────────────────────────

  markFailed(proxyUrl) {
    this.failedProxies.add(proxyUrl)
    const proxy = this.proxies.find(p => p.url === proxyUrl)
    if (proxy) proxy.working = false
    logger.warn(`Proxy marked failed: ${proxyUrl}`)
  }

  // ── GET PLAYWRIGHT PROXY CONFIG ──────────────────────────────
  // Use this in Playwright browser launch options

  async getPlaywrightProxy() {
    const proxy = await this.getProxy()
    if (!proxy) return null

    return {
      server: proxy.url,
      // username: proxy.username,  // For authenticated proxies
      // password: proxy.password
    }
  }

  // ── HELPERS ─────────────────────────────────────────────────

  extractProtocol(url) {
    return url.split('://')[0] || 'http'
  }
  extractHost(url) {
    const withoutProtocol = url.replace(/^https?:\/\//, '')
    return withoutProtocol.split(':')[0]
  }
  extractPort(url) {
    const parts = url.split(':')
    return parseInt(parts[parts.length - 1]) || 8080
  }

  getStats() {
    return {
      total: this.proxies.length,
      working: this.proxies.filter(p => p.working).length,
      failed: this.failedProxies.size,
      lastRefresh: this.lastRefresh
    }
  }
}

// Singleton
const proxyManager = new ProxyManager()

module.exports = proxyManager
