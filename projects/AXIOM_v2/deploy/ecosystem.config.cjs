module.exports = {
  apps: [{
    name: 'axiom2-api',
    cwd: '/home/hq/axiom2/server',
    script: 'index.js',
    env: { NODE_ENV: 'production', PORT: 3102 },
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/home/hq/axiom2/logs/error.log',
    out_file: '/home/hq/axiom2/logs/out.log',
    merge_logs: true,
    max_memory_restart: '512M'
  }]
}
