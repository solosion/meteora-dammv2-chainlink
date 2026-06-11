@echo off
cd /d "%~dp0"

if not exist .env (
  echo ERROR: .env Datei fehlt. Kopiere .env.example nach .env und trage deine Keys ein.
  pause
  exit /b 1
)

echo Building...
call npm run build --silent

echo.
echo === DLMM Buy Wall Tracker ===
echo Dashboard: http://localhost:3000
echo Stoppen:   Ctrl+C
echo.

node dist/index.js
