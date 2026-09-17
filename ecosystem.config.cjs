module.exports = {
  apps: [
    {
      name: 'fair-lottery',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 3000,
        RATE_LIMIT_PER_MIN: 120,
      },
    },
  ],
};
