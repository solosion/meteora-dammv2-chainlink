module.exports = {
  apps: [
    {
      name: "meteora-dammv2-bot",
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
      // Conservative restart to avoid Telegram 409 conflicts.
      // The bot does graceful cleanup on exit (stops Telegram polling),
      // but we still wait 30s before restart to let Telegram release the connection.
      exp_backoff_restart_delay: 5000,
      max_restarts: 10,
      restart_delay: 30000,
      kill_timeout: 10000,
      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,
    },
  ],
};
