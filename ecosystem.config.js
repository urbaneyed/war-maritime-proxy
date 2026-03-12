module.exports = {
  apps: [{
    name: 'war-maritime',
    script: 'server.js',
    cwd: '/Users/rishikhiani/maritime-proxy',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      AISSTREAM_API_KEY: '034a5437399dd60d299c01ae1b7ec89920a4014f',
      PROXY_SECRET: 'war-maritime-2026'
    },
    instances: 1,
    autorestart: true,
    max_restarts: 50,
    restart_delay: 5000,
    watch: false,
    max_memory_restart: '200M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/Users/rishikhiani/logs/war-maritime-error.log',
    out_file: '/Users/rishikhiani/logs/war-maritime-out.log',
    merge_logs: true
  }]
};
