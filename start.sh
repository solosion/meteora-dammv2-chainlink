#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "ERROR: .env Datei fehlt. Kopiere .env.example nach .env und trage deine Keys ein."
  exit 1
fi

echo "Building..."
npm run build --silent

echo ""
echo "=== DLMM Buy Wall Tracker ==="
echo "Dashboard: http://localhost:${DASHBOARD_PORT:-3000}"
echo "Stoppen:   Ctrl+C"
echo ""

node dist/index.js
