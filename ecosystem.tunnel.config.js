module.exports = {
  apps: [
    {
      name: 'users-top-api-tunnel',
      script: '/usr/local/bin/cloudflared',
      cwd: __dirname,
      args: 'tunnel --config cloudflared-empty.yml --url http://127.0.0.1:3000 --no-autoupdate',
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
