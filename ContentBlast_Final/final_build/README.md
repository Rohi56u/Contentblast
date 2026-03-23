# 🚀 Content Distributor — Complete Setup Guide

## What This Does
Auto-distributes your YouTube & Instagram content to:
- ✈️ Telegram Groups (Official API — FREE)
- 🔴 Reddit Subreddits (Official API — FREE)
- 🎮 Discord Channels (Official Bot — FREE)
- 📘 Facebook Groups (Playwright automation — FREE)
- 💬 WhatsApp Groups (whatsapp-web.js — FREE)

**Total Cost: ₹0**

---

## 📁 Project Structure

```
content-distributor/
├── src/
│   ├── api/
│   │   ├── server.js          ← Main Express server
│   │   └── routes.js          ← All API endpoints
│   ├── config/
│   │   ├── config.js          ← Config loader
│   │   └── logger.js          ← Winston logger
│   ├── database/
│   │   └── db.js              ← SQLite database
│   ├── processors/
│   │   └── linkProcessor.js   ← YouTube/Instagram link parser
│   ├── caption/
│   │   └── captionEngine.js   ← Platform-wise caption generator
│   ├── platforms/
│   │   ├── telegram.js        ← Telegram Bot API
│   │   ├── reddit.js          ← Reddit API (snoowrap)
│   │   ├── discord.js         ← Discord Bot
│   │   ├── facebook.js        ← Playwright automation
│   │   └── whatsapp.js        ← whatsapp-web.js
│   └── scheduler/
│       └── distributor.js     ← Main orchestrator
├── dashboard/
│   └── index.html             ← Full web dashboard
├── data/                      ← SQLite DB (auto-created)
├── sessions/                  ← Platform sessions (auto-created)
├── logs/                      ← Log files (auto-created)
├── .env.example               ← Copy to .env
└── package.json
```

---

## ⚡ Quick Start (Step by Step)

### Step 1 — Install Node.js
Download from https://nodejs.org (v18 or above)

### Step 2 — Install Dependencies
```bash
cd content-distributor
npm install
npx playwright install chromium
```

### Step 3 — Setup Config
```bash
cp .env.example .env
```
Open `.env` and fill in your credentials (see below)

### Step 4 — Start Server
```bash
npm start
```
Server starts at http://localhost:3000

### Step 5 — Open Dashboard
Open `dashboard/index.html` in your browser
OR visit http://localhost:3000 (if dashboard is built)

---

## 🔑 Platform Setup — One by One

### ✈️ Telegram (5 minutes)
1. Open Telegram, search `@BotFather`
2. Send `/newbot`
3. Give it a name and username
4. Copy the TOKEN
5. Add to `.env`: `TELEGRAM_BOT_TOKEN=your_token`
6. Add your bot to groups (make it admin)
7. Get group ID: Forward a group message to `@userinfobot`

### 🔴 Reddit (10 minutes)
1. Go to https://www.reddit.com/prefs/apps
2. Click "Create App"
3. Choose type: **script**
4. Set redirect_uri: `http://localhost:8080`
5. Copy `client_id` (under app name) and `secret`
6. Add to `.env`:
```
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_secret
REDDIT_USERNAME=your_reddit_username
REDDIT_PASSWORD=your_reddit_password
```

### 🎮 Discord (5 minutes)
1. Go to https://discord.com/developers/applications
2. Click "New Application"
3. Go to "Bot" tab → Click "Add Bot"
4. Copy TOKEN
5. Enable these permissions: Send Messages, Embed Links
6. Invite bot to your server with these permissions
7. Enable Developer Mode in Discord settings
8. Right-click channel → Copy ID (this is your group_id for Discord)
9. Add to `.env`: `DISCORD_BOT_TOKEN=your_token`

### 📘 Facebook (2 minutes setup, Playwright handles rest)
```
FACEBOOK_EMAIL=your_email@gmail.com
FACEBOOK_PASSWORD=your_password
```
System will automatically log in and save session.
⚠️ Use a secondary account, not your main account.

### 💬 WhatsApp (QR scan)
1. Add to `.env`: `WHATSAPP_SESSION_PATH=./sessions/whatsapp`
2. First run → QR code appears in terminal
3. Open WhatsApp on phone → Linked Devices → Scan QR
4. Done! Session saved automatically for future runs

To get WhatsApp Group IDs, hit: `GET /api/whatsapp/groups` after connecting.

---

## 📡 API Reference

```
POST /api/preview
  Body: { "url": "https://youtu.be/xxx" }
  Returns: Video title, thumbnail, channel info

POST /api/distribute
  Body: {
    "youtubeUrl": "https://youtu.be/xxx",
    "instagramUrl": "https://instagram.com/p/xxx",
    "selectedPlatforms": ["telegram", "reddit", "discord"],
    "niche": "tech"
  }
  Returns: { sessionId } → then connect to /api/progress/:sessionId for live updates

GET /api/groups              → List all groups
POST /api/groups             → Add a group
DELETE /api/groups/:id       → Remove a group
GET /api/campaigns           → Campaign history
GET /api/stats               → Analytics
GET /api/connections         → Test all platform connections
```

---

## 👥 How to Add Groups

Via Dashboard:
1. Open dashboard → Groups tab
2. Click "Add Group"
3. Select platform, enter name and ID, choose niche

Via API:
```bash
curl -X POST http://localhost:3000/api/groups \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "telegram",
    "group_id": "-1001234567890",
    "group_name": "Tech Community",
    "niche": "tech"
  }'
```

---

## 🛡️ Anti-Spam Built-In

- Minimum 30s delay between Telegram posts
- 1-2 minute delays between Reddit posts
- 2-5 minute delays between Facebook posts
- Will NOT post to same group twice in 24 hours
- Human-like typing speed for Playwright

---

## 🚀 Hosting for Free

### Option 1 — Run Locally (Simplest)
Just run `npm start` when you want to distribute.

### Option 2 — Oracle Cloud (Always Free VPS)
1. Sign up at https://cloud.oracle.com
2. Create "Always Free" compute instance
3. SSH in → `git clone your-repo`
4. `npm install && npm start`
5. Use `pm2` to keep it running: `pm2 start src/api/server.js`

### Option 3 — Railway.app
1. Push code to GitHub
2. Connect repo on https://railway.app
3. Set environment variables
4. Deploy → Free tier available

---

## ❓ Troubleshooting

**Telegram: "Chat not found"**
→ Make sure bot is added to the group as admin

**Reddit: "RATELIMIT" error**
→ Normal, system auto-waits. Reddit limits new accounts.

**Facebook: "Could not find composer"**
→ Facebook UI changes. Check if account requires verification.

**WhatsApp: QR code expired**
→ Delete `./sessions/whatsapp` folder and restart

**Discord: Missing Permissions**
→ Bot needs "Send Messages" + "Embed Links" permission in channel

---

## 📊 Database Tables

All data stored locally in `./data/distributor.db` (SQLite)

- `groups` — All your groups/channels/subreddits
- `campaigns` — Every distribution run
- `post_logs` — Individual post results

---

## 🔒 Security Tips

- Never commit `.env` to Git (add to `.gitignore`)
- Use secondary/alt accounts for Facebook
- Keep posting limits conservative to avoid bans
- Sessions stored locally in `./sessions/` — keep safe

---

Made with ❤️ — Total Cost: ₹0
