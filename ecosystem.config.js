module.exports = {
  apps: [
    {
      name: "meteora-dammv2-pool-tailer",
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
      // Restart if process uses too much memory or crashes
      exp_backoff_restart_delay: 1000,
      max_restarts: 50,
      restart_delay: 5000,
      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,
    },
  ],
};
