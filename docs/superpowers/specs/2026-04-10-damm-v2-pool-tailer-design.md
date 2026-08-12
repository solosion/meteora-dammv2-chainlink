# Meteora DAMM v2 Pool Tailer - Design Spec

## Overview

Rebuild the existing Telegram-alert-driven LP bot into a **real-time pool tailer** that detects new Meteora DAMM v2 pool creations via Solana WebSocket and immediately opens liquidity positions. Remove Chainlink references and Telegram alert parsing. Keep Telegram admin commands for monitoring.

## Detection

- **Method**: WebSocket subscription via `connection.onLogs()` on the Meteora DAMM v2 program ID.
- **Target**: `initialize` instruction logs indicating a new pool creation.
- **On detection**: Parse TX to extract pool address, token A/B mints, creator address, initial liquidity.

## Filters

All filters run before opening a position:

1. **SOL-paired only**: At least one side of the pool must be native SOL (wrapped SOL mint).
2. **Minimum liquidity**: Initial pool liquidity must exceed `MIN_POOL_LIQUIDITY_SOL` (default 1.0 SOL).
3. **Creator whitelist**: If `CREATOR_WHITELIST` is non-empty, only tail pools from those addresses.
4. **Creator blacklist**: Skip pools from addresses in `CREATOR_BLACKLIST`.

## Position Opening

- **Sizing**: Fixed SOL amount from `POSITION_SIZE_SOL` (default 0.5 SOL).
- **Risk limits**: Max open positions, max total exposure, minimum wallet reserve (0.05 SOL).
- **Execution**: Use existing `createPositionAndAddLiquidity()` from Meteora CP-AMM SDK.
- **Tracking**: Persist to `data/positions.json` with pool address, entry value, timestamps.

## Exit Rules

Monitoring loop runs every `MONITOR_INTERVAL_SECONDS` (default 30s). First trigger wins:

1. **Stop-loss**: Position value dropped `STOP_LOSS_PERCENT`% from entry (default 20%).
2. **Take-profit**: Position value gained `TAKE_PROFIT_PERCENT`% from entry (default 50%).
3. **Max hold time**: Position open longer than `MAX_HOLD_MINUTES` (default 60 min).

On exit: close position via SDK, record P&L, notify admin via Telegram.

## Configuration (.env)

```
SOLANA_RPC_URL=                  # Helius HTTP RPC
SOLANA_WS_URL=                   # Helius WebSocket endpoint (wss://)
SOLANA_SEED_PHRASE=              # BIP-39 mnemonic

POSITION_SIZE_SOL=0.5
MAX_OPEN_POSITIONS=10
MAX_TOTAL_EXPOSURE_SOL=5.0

MIN_POOL_LIQUIDITY_SOL=1.0
CREATOR_WHITELIST=               # Comma-separated pubkeys (empty = allow all)
CREATOR_BLACKLIST=               # Comma-separated pubkeys

STOP_LOSS_PERCENT=20
TAKE_PROFIT_PERCENT=50
MAX_HOLD_MINUTES=60
MONITOR_INTERVAL_SECONDS=30

TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_CHAT_ID=

LOG_LEVEL=info
```

## Components

### New
- `src/listener/pool-listener.ts` — WebSocket subscription, TX parsing, event emission.
- `src/filter/pool-filter.ts` — SOL-pair check, liquidity threshold, creator whitelist/blacklist.

### Modified
- `src/solana/connection.ts` — Add WebSocket URL config and WSS connection.
- `src/risk/manager.ts` — Add max hold time exit logic.
- `src/telegram/bot.ts` — Remove alert listener. Keep admin commands and notification sending.
- `src/config.ts` — New env vars for WebSocket, filters, hold time. Remove alert-specific vars.
- `src/index.ts` — Rewrite orchestration: listener -> filter -> open position -> monitor.

### Kept As-Is
- `src/meteora/client.ts` — Meteora SDK init.
- `src/meteora/pools.ts` — Pool state fetching.
- `src/meteora/positions.ts` — Position open/close logic.
- `src/solana/wallet.ts` — HD wallet derivation.
- `src/tracker/store.ts` — Persistent position tracking.
- `src/utils/logger.ts` — Winston logging.

### Deleted
- `src/telegram/parser.ts` — No longer needed (was parsing alert messages for token addresses).

## Data Flow

```
Solana WebSocket
  -> onLogs(DAMM_V2_PROGRAM_ID)
  -> detect "initialize" instruction
  -> parse TX: pool address, token mints, creator, liquidity
  -> pool-filter: SOL-paired? min liquidity? creator allowed?
  -> risk check: open slots? exposure limit? balance?
  -> openPosition(pool, SOL amount)
  -> track in store, notify admin

Monitor loop (every 30s):
  -> for each open position:
     -> estimate current value
     -> check stop-loss / take-profit / max hold time
     -> if triggered: closePosition(), record P&L, notify admin
```

## Error Handling

- WebSocket disconnects: auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s).
- TX parsing failures: log warning, skip pool, do not crash.
- Position open failures: log error, notify admin, continue listening.
- RPC rate limits: retry with backoff on 429 responses.

## Testing Strategy

- Unit tests for pool-filter (SOL-pair detection, whitelist/blacklist, liquidity threshold).
- Unit tests for TX log parsing (mock onLogs payloads).
- Integration test: end-to-end with devnet pool creation -> detection -> position open.
