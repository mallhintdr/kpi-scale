#!/usr/bin/env bash
# Update the KPI Dashboard on the VPS: pull the latest code, build backend and frontend, restart PM2.
#
#   On the VPS:      bash /kpi-bwp/update.sh
#   From your PC:    ssh root@<VPS-IP> "bash /kpi-bwp/update.sh"
#
# Stops at the first error, so a failed build never restarts the app with broken code
# (the running version keeps working until the next successful update).

# Everything is inside main() so bash reads the whole script before running it:
# `git pull` may replace this very file while it runs.
main() {
  set -euo pipefail
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$dir"

  step() { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
  local started=$SECONDS

  step "Pulling the latest code ($dir)"
  local before after
  before="$(git rev-parse --short HEAD)"
  git pull --ff-only
  after="$(git rev-parse --short HEAD)"
  if [ "$before" = "$after" ] && [ "${1:-}" != "--force" ]; then
    echo "Already up to date ($after). Nothing to do — run with --force to rebuild anyway."
    exit 0
  fi
  git log --oneline "$before..$after" 2>/dev/null | head -20 || true

  step "Backend: install and build"
  cd "$dir/server"
  npm ci --no-audit --no-fund
  npm run build

  step "Database: indexes and blueprint updates"
  node dist/migrate.js

  step "Frontend: install and build"
  cd "$dir/web"
  npm ci --no-audit --no-fund
  npm run build
  chmod -R o+r "$dir/web/dist"   # nginx reads the website files

  step "Restarting the app"
  cd "$dir"
  if pm2 describe kpi-api >/dev/null 2>&1; then
    pm2 restart kpi-api kpi-worker --update-env
  else
    pm2 start ecosystem.config.cjs   # first run
  fi
  pm2 save >/dev/null

  step "Checking"
  sleep 3
  local port
  port="$(grep -E '^PORT=' "$dir/server/.env" | cut -d= -f2 | tr -d '[:space:]' || true)"
  if curl -fsS "http://127.0.0.1:${port:-4100}/health" >/dev/null; then
    echo "API is up on port ${port:-4100}."
  else
    echo "WARNING: the API did not answer on port ${port:-4100} — check: pm2 logs kpi-api --lines 50"
  fi
  pm2 ls

  step "Done: $before → $after in $((SECONDS - started))s"
}

main "$@"
