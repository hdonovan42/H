module.exports = {
  apps: [{
    name: 'autosnipe-api',
    cwd: '/home/hq/autosnipe/server',
    script: 'index.js',
    interpreter: '/home/hq/.nvm/versions/node/v22.22.0/bin/node',
    env: { NODE_ENV: 'production', PORT: 3103, DISPLAY: ':99' },
    kill_timeout: 10000,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/home/hq/autosnipe/logs/error.log',
    out_file: '/home/hq/autosnipe/logs/out.log',
    merge_logs: true,
    max_memory_restart: '512M'
  }]
}
