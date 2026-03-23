const axios = require('axios')
const logger = require('../config/logger')

// ─────────────────────────────────────────────────────────────────
// AI CAPTION ENGINE
//
// Priority:
// 1. Ollama (FREE — runs locally on your PC)
//    Install: https://ollama.ai → ollama pull llama2
// 2. OpenAI GPT (paid but best quality)
// 3. Smart templates (always works, no setup needed)
//
// How to use Ollama (100% FREE):
//   curl https://ollama.ai/install.sh | sh
//   ollama pull mistral
//   → Then set OLLAMA_ENABLED=true in .env
// ─────────────────────────────────────────────────────────────────

// ── AI PROVIDERS ─────────────────────────────────────────────────

async function generateWithOllama(prompt) {
  try {
    const model = process.env.OLLAMA_MODEL || 'mistral'
    const res = await axios.post('http://localhost:11434/api/generate', {
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0.8,
        max_tokens: 300
      }
    }, { timeout: 30000 })

    return res.data.response?.trim() || null
  } catch (err) {
    logger.warn(`Ollama not available: ${err.message}`)
    return null
  }
}

async function generateWithOpenAI(prompt) {
  try {
    if (!process.env.OPENAI_API_KEY) return null

    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.8
    }, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: 20000
    })

    return res.data.choices?.[0]?.message?.content?.trim() || null
  } catch (err) {
    logger.warn(`OpenAI not available: ${err.message}`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────
// BUILD PROMPT FOR CAPTION GENERATION
// ─────────────────────────────────────────────────────────────────

function buildCaptionPrompt(videoTitle, platform, niche, videoUrl) {
  const platformInstructions = {
    telegram: 'Write a Telegram group post. Use emojis, bold with *asterisks*, keep it punchy and engaging. Max 200 words.',
    facebook: 'Write a Facebook group post. Conversational, engaging, use emojis. Ask a question at end. Max 150 words.',
    reddit: 'Write a Reddit post title only. No emojis. Clear, interesting, no clickbait. Max 15 words.',
    discord: 'Write a Discord server announcement. Hype it up, use emojis, short. Max 100 words.',
    whatsapp: 'Write a WhatsApp message. Short, informal, use emojis. Max 80 words.',
    linkedin: 'Write a LinkedIn post. Professional but engaging. Add value, mention what viewers will learn. Max 200 words.',
    twitter: 'Write a tweet. Max 240 characters total including URL. Punchy, use relevant hashtags.'
  }

  return `You are a social media expert. Generate a ${platform} caption for this video.

Video Title: "${videoTitle}"
Niche/Category: ${niche}
Video URL: ${videoUrl}
Platform: ${platform}

Instructions: ${platformInstructions[platform] || platformInstructions.telegram}

Output ONLY the caption text, nothing else. No explanations, no labels.`
}

// ─────────────────────────────────────────────────────────────────
// GENERATE AI CAPTION
// ─────────────────────────────────────────────────────────────────

async function generateAICaption(videoTitle, platform, niche, videoUrl) {
  const prompt = buildCaptionPrompt(videoTitle, platform, niche, videoUrl)

  // Try providers in order
  let aiCaption = null

  // 1. Try Ollama (free local)
  if (process.env.OLLAMA_ENABLED === 'true') {
    aiCaption = await generateWithOllama(prompt)
    if (aiCaption) logger.info(`AI caption generated via Ollama for ${platform}`)
  }

  // 2. Try OpenAI (paid)
  if (!aiCaption && process.env.OPENAI_API_KEY) {
    aiCaption = await generateWithOpenAI(prompt)
    if (aiCaption) logger.info(`AI caption generated via OpenAI for ${platform}`)
  }

  return aiCaption  // null if no AI available
}

// ─────────────────────────────────────────────────────────────────
// GENERATE ALL PLATFORM CAPTIONS WITH AI
// Falls back to templates if AI unavailable
// ─────────────────────────────────────────────────────────────────

async function generateAllAICaptions(videoData, niche = 'general') {
  const { title, shareUrl, channelName } = videoData
  const platforms = ['telegram', 'facebook', 'reddit', 'discord', 'whatsapp', 'linkedin', 'twitter']
  const captions = {}

  // Check if any AI is available
  const aiAvailable = process.env.OLLAMA_ENABLED === 'true' || !!process.env.OPENAI_API_KEY

  if (!aiAvailable) {
    logger.info('No AI configured, using smart templates')
    return null  // Caller will use template captions
  }

  logger.info(`Generating AI captions for ${platforms.length} platforms...`)

  // Generate in parallel (faster)
  const results = await Promise.allSettled(
    platforms.map(async (platform) => {
      const aiText = await generateAICaption(title, platform, niche, shareUrl)
      if (!aiText) return null

      // Format based on platform
      if (platform === 'telegram') {
        return { text: `${aiText}\n\n👉 ${shareUrl}`, parseMode: 'Markdown' }
      } else if (platform === 'reddit') {
        return { title: aiText, text: shareUrl }
      } else if (platform === 'discord') {
        return {
          content: aiText,
          embeds: [{
            title,
            url: shareUrl,
            color: 0xFF0000,
            description: aiText.slice(0, 200)
          }]
        }
      } else {
        return { text: `${aiText}\n\n${shareUrl}` }
      }
    })
  )

  // Build captions map
  platforms.forEach((platform, i) => {
    if (results[i].status === 'fulfilled' && results[i].value) {
      captions[platform] = results[i].value
    }
  })

  const generatedCount = Object.keys(captions).length
  logger.info(`AI captions generated: ${generatedCount}/${platforms.length}`)

  return generatedCount > 0 ? captions : null
}

// ─────────────────────────────────────────────────────────────────
// A/B TEST CAPTIONS
// Generate 2 variations and track which performs better
// ─────────────────────────────────────────────────────────────────

async function generateABVariants(videoTitle, platform, niche, videoUrl) {
  const variants = []

  const prompts = [
    buildCaptionPrompt(videoTitle, platform, niche, videoUrl),
    `Write a different, more EMOTIONAL ${platform} post for: "${videoTitle}". Make people feel they MUST watch this. Include ${videoUrl}. Output ONLY the post text.`
  ]

  for (const prompt of prompts) {
    let caption = null
    if (process.env.OLLAMA_ENABLED === 'true') {
      caption = await generateWithOllama(prompt)
    } else if (process.env.OPENAI_API_KEY) {
      caption = await generateWithOpenAI(prompt)
    }

    if (caption) variants.push(caption)
  }

  return variants
}

// ─────────────────────────────────────────────────────────────────
// CHECK AI STATUS
// ─────────────────────────────────────────────────────────────────

async function checkAIStatus() {
  const status = {
    ollama: { available: false, model: null },
    openai: { available: false }
  }

  // Check Ollama
  try {
    const res = await axios.get('http://localhost:11434/api/tags', { timeout: 3000 })
    status.ollama.available = true
    status.ollama.models = res.data?.models?.map(m => m.name) || []
  } catch { /* not running */ }

  // Check OpenAI
  status.openai.available = !!process.env.OPENAI_API_KEY

  return status
}

module.exports = {
  generateAICaption,
  generateAllAICaptions,
  generateABVariants,
  checkAIStatus
}
