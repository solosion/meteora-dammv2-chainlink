# Meteora DAMM v2 Bot - Development Guidelines

## Deployment Reminder
After every commit & push, ALWAYS provide the user with the deploy commands for the server:

```bash
cd /opt/meteora-dammv2-bot
pkill -9 -f "node dist/index.js"
git pull origin <branch-name>
npm install
npm run build
sleep 30 && nohup node dist/index.js > bot.log 2>&1 &
```

The user will forget to pull the new code otherwise.

## Testing
- Always run `npm test` before finishing work
- All tests must pass before committing
- Test files are in `src/__tests__/`

## Build
- `npm run build` compiles TypeScript to `dist/`
- `npm test` runs Jest tests

## Bot runs on
- Server: `/opt/meteora-dammv2-bot`
- Start: `nohup node dist/index.js > bot.log 2>&1 &`
- Logs: `tail -f bot.log`
