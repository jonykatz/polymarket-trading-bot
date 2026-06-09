#!/usr/bin/env bash
# One-time DigitalOcean droplet setup for polymarket-bot (Ubuntu + Node 20).
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/polymarket-trading-bot}"
REPO_URL="${REPO_URL:-https://github.com/jonykatz/polymarket-trading-bot.git}"
BRANCH="${BRANCH:-dev}"

echo "==> Node $(node -v) / npm $(npm -v)"

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "==> Cloning $REPO_URL -> $REPO_DIR"
  git clone "$REPO_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"
echo "==> Updating branch $BRANCH"
git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"

if [[ ! -f .env ]]; then
  echo ""
  echo "ERROR: .env not found in $REPO_DIR"
  echo "From your Mac (do not paste secrets in chat):"
  echo "  scp /path/to/.env root@YOUR_DROPLET_IP:$REPO_DIR/.env"
  exit 1
fi

echo "==> Installing dependencies"
npm install

echo "==> Building"
npm run build

echo "==> CLOB verify"
npm run clob:verify

echo "==> CLOB balance"
npm run clob:balance

echo "==> Starting PM2"
npm run pm2:start

echo "==> PM2 startup (survives reboot)"
STARTUP_CMD="$(npx pm2 startup systemd -u "${USER:-root}" --hp "${HOME}" | grep -E '^sudo ' || true)"
if [[ -n "$STARTUP_CMD" ]]; then
  echo "Run this if not already done:"
  echo "  $STARTUP_CMD"
  eval "$STARTUP_CMD" || true
fi
npx pm2 save

echo ""
echo "Done. Tail logs: cd $REPO_DIR && npm run pm2:logs"
echo "Status: npm run pm2:status"
