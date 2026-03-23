// ─────────────────────────────────────────────────────────────────
// BROWSER STEALTH MANAGER
// Playwright ke liye random human-like browser config
// Automation detection se bachne ke liye
// ─────────────────────────────────────────────────────────────────

// Real User Agents pool — rotate karo har baar
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
]

// Common screen resolutions
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1280, height: 720 },
]

// Timezones
const TIMEZONES = [
  'Asia/Kolkata', 'America/New_York', 'America/Los_Angeles',
  'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Singapore'
]

// Locales
const LOCALES = ['en-IN', 'en-US', 'en-GB', 'en-AU']

// ─────────────────────────────────────────────────────────────────
// GENERATE RANDOM BROWSER PROFILE
// ─────────────────────────────────────────────────────────────────

function getRandomProfile() {
  return {
    userAgent: randomFrom(USER_AGENTS),
    viewport: randomFrom(VIEWPORTS),
    timezone: randomFrom(TIMEZONES),
    locale: randomFrom(LOCALES),
  }
}

// ─────────────────────────────────────────────────────────────────
// STEALTH BROWSER LAUNCH OPTIONS
// Pass this to playwright.chromium.launch()
// ─────────────────────────────────────────────────────────────────

function getStealthLaunchOptions(headless = true) {
  return {
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',  // Hide automation flag
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--lang=en-US,en',
    ],
    ignoreDefaultArgs: ['--enable-automation'],  // Remove automation flag
  }
}

// ─────────────────────────────────────────────────────────────────
// STEALTH CONTEXT OPTIONS
// Pass this to browser.newContext()
// ─────────────────────────────────────────────────────────────────

function getStealthContextOptions(profile = null, proxyConfig = null) {
  const p = profile || getRandomProfile()

  const options = {
    userAgent: p.userAgent,
    viewport: p.viewport,
    timezoneId: p.timezone,
    locale: p.locale,

    // Realistic browser permissions
    permissions: ['geolocation', 'notifications'],

    // Real headers
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    },

    // Bypass CSP
    bypassCSP: true,
  }

  if (proxyConfig) {
    options.proxy = proxyConfig
  }

  return options
}

// ─────────────────────────────────────────────────────────────────
// INJECT STEALTH SCRIPTS
// Call this after page creation to hide automation markers
// ─────────────────────────────────────────────────────────────────

async function injectStealthScripts(page) {
  // Override webdriver property
  await page.addInitScript(() => {
    // Delete navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    })

    // Override plugins (real browser has some)
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    })

    // Override languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    })

    // Override permissions
    const originalQuery = window.navigator.permissions.query
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters)

    // Override chrome object (real Chrome has this)
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {}
    }

    // Realistic screen dimensions
    Object.defineProperty(window.screen, 'availWidth', { get: () => window.innerWidth })
    Object.defineProperty(window.screen, 'availHeight', { get: () => window.innerHeight })
  })
}

// ─────────────────────────────────────────────────────────────────
// HUMAN-LIKE MOUSE MOVEMENT
// ─────────────────────────────────────────────────────────────────

async function humanMouseMove(page, targetX, targetY) {
  // Get current position
  const currentPos = { x: 100, y: 100 }

  // Create bezier curve path
  const steps = 10 + Math.floor(Math.random() * 10)
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = Math.round(currentPos.x + (targetX - currentPos.x) * t + (Math.random() - 0.5) * 5)
    const y = Math.round(currentPos.y + (targetY - currentPos.y) * t + (Math.random() - 0.5) * 5)
    await page.mouse.move(x, y)
    await sleep(10 + Math.random() * 20)
  }
}

// ─────────────────────────────────────────────────────────────────
// HUMAN-LIKE TYPING
// ─────────────────────────────────────────────────────────────────

async function humanType(page, selector, text) {
  await page.click(selector)
  await sleep(300 + Math.random() * 500)

  // Type with variable speed and occasional mistakes
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i])

    // Variable delay (humans don't type at constant speed)
    const delay = 50 + Math.random() * 100
    await sleep(delay)

    // Occasional pause (thinking)
    if (Math.random() < 0.05) {
      await sleep(500 + Math.random() * 1000)
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// RANDOM HUMAN DELAYS
// ─────────────────────────────────────────────────────────────────

async function humanPause(minMs = 1000, maxMs = 3000) {
  await sleep(minMs + Math.random() * (maxMs - minMs))
}

// Simulate reading (proportional to content length)
async function humanReadDelay(text) {
  const wordsPerMinute = 200 + Math.random() * 100
  const words = text.split(' ').length
  const readTime = (words / wordsPerMinute) * 60 * 1000
  await sleep(Math.min(readTime, 5000))  // Max 5 seconds
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

module.exports = {
  getRandomProfile,
  getStealthLaunchOptions,
  getStealthContextOptions,
  injectStealthScripts,
  humanMouseMove,
  humanType,
  humanPause,
  humanReadDelay,
}
