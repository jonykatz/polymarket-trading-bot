const path = require("path");

/** pm2: live bot + activity reporter — `npm run pm2:start` */
module.exports = {
  apps: [
    {
      name: "polymarket-bot",
      script: path.join(__dirname, "dist/main.js"),
      cwd: __dirname,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      merge_logs: true,
      time: true,
      out_file: path.join(__dirname, "logs/pm2-out.log"),
      error_file: path.join(__dirname, "logs/pm2-error.log")
    },
    {
      name: "polymarket-reporter",
      script: path.join(__dirname, "dist/reportingLoop.js"),
      cwd: __dirname,
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      merge_logs: true,
      time: true,
      out_file: path.join(__dirname, "logs/pm2-reporter-out.log"),
      error_file: path.join(__dirname, "logs/pm2-reporter-error.log")
    }
  ]
};
