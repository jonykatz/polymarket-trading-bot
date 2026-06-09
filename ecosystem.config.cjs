const path = require("path");

/** pm2: live bot 24/7 on your Mac — `npm run pm2:start` */
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
    }
  ]
};
