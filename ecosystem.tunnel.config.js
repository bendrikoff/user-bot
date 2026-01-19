module.exports = {
  apps: [
    {
      name: 'users-top-api-tunnel',
      script: '/usr/local/bin/cloudflared',
      args: 'tunnel --url http://127.0.0.1:3000',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
