// ─────────────────────────────────────────────────────────────────
// PM2 ECOSYSTEM — ContentBlast
//
// Install PM2:     npm install -g pm2
// Start all:       pm2 start ecosystem.config.js
// Monitor:         pm2 monit
// View logs:       pm2 logs
// Auto-start:      pm2 startup → pm2 save
// Stop all:        pm2 stop all
// ─────────────────────────────────────────────────────────────────

module.exports = {
  apps: [
    // ── MAIN API SERVER ────────────────────────────────────────
    {
      name: 'contentblast-api',
      script: './src/api/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      restart_delay: 3000,
      max_restarts: 50,           // Keep trying — never give up
      min_uptime: '5s',
      exp_backoff_restart_delay: 100,

      env: { NODE_ENV: 'production', PORT: 3000 },

      error_file: './logs/api-error.log',
      out_file: './logs/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      log_file: './logs/api-combined.log',
      kill_timeout: 5000,
      listen_timeout: 10000,
    },

    // ── QUEUE WORKER ──────────────────────────────────────────
    {
      name: 'contentblast-worker',
      script: './src/queue/worker.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      restart_delay: 5000,
      max_restarts: 30,
      min_uptime: '5s',

      env: { NODE_ENV: 'production' },

      error_file: './logs/worker-error.log',
      out_file: './logs/worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },

    // ── SCHEDULER ────────────────────────────────────────────
    {
      name: 'contentblast-scheduler',
      script: './src/analytics/bestTimeScheduler.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      restart_delay: 5000,
      max_restarts: 30,

      env: { NODE_ENV: 'production' },

      error_file: './logs/scheduler-error.log',
      out_file: './logs/scheduler-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    }
  ]
}
