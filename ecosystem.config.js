module.exports = {
  apps: [
    {
      name: "aintivirus-web",
      script: "node_modules/.bin/next",
      args: "start -p 3002",
      node_args: "--max-old-space-size=768",
      cwd: "/var/www/aintivirus-drudgereport",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3002,
      },
      error_file: "/var/log/aintivirus/web-error.log",
      out_file: "/var/log/aintivirus/web-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      exp_backoff_restart_delay: 1000, // Exponential backoff on crash (1s, 2s, 4s, ...)
      max_restarts: 50, // Prevent infinite restart loops
    },
    {
      name: "aintivirus-bot",
      script: "npx",
      args: "tsx bot/index.ts",
      cwd: "/var/www/aintivirus-drudgereport",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      error_file: "/var/log/aintivirus/bot-error.log",
      out_file: "/var/log/aintivirus/bot-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      kill_timeout: 35000, // Give bot 5 seconds to gracefully disconnect from Telegram
      wait_ready: false, // Wait for process to be ready before considering it started
      listen_timeout: 45000, // Timeout for ready signal
      restart_delay: 35000, // 35s fixed delay — wait for Telegram long-poll to expire
      max_restarts: 50,
    },
    {
      name: "aintivirus-scheduler",
      script: "npx",
      args: "tsx worker/scheduler.ts",
      cwd: "/var/www/aintivirus-drudgereport",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      error_file: "/var/log/aintivirus/scheduler-error.log",
      out_file: "/var/log/aintivirus/scheduler-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      kill_timeout: 35000, // 35s — scheduler waits up to 30s for in-progress work
      exp_backoff_restart_delay: 1000,
      max_restarts: 50,
    },
  ],
};
