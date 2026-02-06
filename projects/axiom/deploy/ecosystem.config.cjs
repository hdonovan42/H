module.exports = {
  apps: [{
    name: 'axiom-api',
    cwd: '/home/hq/axiom/server',
    script: 'index.js',
    env: { NODE_ENV: 'production', PORT: 3101 },
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/home/hq/axiom/logs/error.log',
    out_file: '/home/hq/axiom/logs/out.log',
    merge_logs: true,
    max_memory_restart: '512M'
  }]
}
