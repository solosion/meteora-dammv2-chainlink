# DAMM v2 Pool Tailer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Telegram-alert LP bot into a real-time WebSocket-based pool tailer that detects new Meteora DAMM v2 pool creations and immediately opens liquidity positions.

**Architecture:** WebSocket subscription on the Meteora DAMM v2 program (`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`) detects `initializePool`/`initializeCustomizablePool`/`initializePoolWithDynamicConfig` instruction logs. Parsed pool addresses pass through filters (SOL-paired, min liquidity, creator whitelist/blacklist) before opening a fixed-size LP position. A monitoring loop handles stop-loss, take-profit, and max-hold-time exits.

**Tech Stack:** TypeScript, @solana/web3.js (WebSocket + RPC), @meteora-ag/cp-amm-sdk, Telegraf, Winston

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/config.ts` | Modify | Add WS URL, filter, and hold-time config; remove alert parser config |
| `src/solana/connection.ts` | Modify | Add `getWsEndpoint()` for WebSocket URL |
| `src/listener/pool-listener.ts` | Create | WebSocket subscription, TX parsing, event emission |
| `src/filter/pool-filter.ts` | Create | SOL-pair check, liquidity threshold, creator whitelist/blacklist |
| `src/risk/manager.ts` | Modify | Add max hold time exit check |
| `src/telegram/bot.ts` | Modify | Remove alert channel listener, keep admin commands + notifications |
| `src/index.ts` | Rewrite | New orchestration: listener → filter → position → monitor |
| `src/telegram/parser.ts` | Delete | No longer needed |
| `.env.example` | Rewrite | New config template |
| `tests/filter.test.ts` | Create | Pool filter unit tests |
| `tests/listener.test.ts` | Create | Pool listener parsing unit tests |

---

### Task 1: Update config.ts — new env vars, remove alert parser

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Update config.ts with new schema**

Replace the entire config file:

```typescript
import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  solana: {
    rpcUrl: required("SOLANA_RPC_URL"),
    wsUrl: optional("SOLANA_WS_URL", ""),
    seedPhrase: required("SOLANA_SEED_PHRASE"),
  },
  position: {
    sizeSol: parseFloat(optional("POSITION_SIZE_SOL", "0.5")),
    maxOpenPositions: parseInt(optional("MAX_OPEN_POSITIONS", "10"), 10),
    maxTotalExposureSol: parseFloat(optional("MAX_TOTAL_EXPOSURE_SOL", "5.0")),
  },
  filter: {
    minPoolLiquiditySol: parseFloat(optional("MIN_POOL_LIQUIDITY_SOL", "1.0")),
    creatorWhitelist: optional("CREATOR_WHITELIST", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    creatorBlacklist: optional("CREATOR_BLACKLIST", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  risk: {
    stopLossPercent: parseFloat(optional("STOP_LOSS_PERCENT", "20")),
    takeProfitPercent: parseFloat(optional("TAKE_PROFIT_PERCENT", "50")),
    maxHoldMinutes: parseInt(optional("MAX_HOLD_MINUTES", "60"), 10),
  },
  monitor: {
    intervalSeconds: parseInt(optional("MONITOR_INTERVAL_SECONDS", "30"), 10),
  },
  telegram: {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    adminChatId: required("TELEGRAM_ADMIN_CHAT_ID"),
  },
  logLevel: optional("LOG_LEVEL", "info"),
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/raphael/meteora-dammv2-chainlink && npx tsc --noEmit src/config.ts`
Expected: Compilation errors in files that import old config shape (that's fine, we'll fix them in later tasks)

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: update config for pool tailer — add WS, filter, hold-time vars"
```

---

### Task 2: Update connection.ts — add WebSocket endpoint

**Files:**
- Modify: `src/solana/connection.ts`

- [ ] **Step 1: Add WS endpoint resolution**

Replace `src/solana/connection.ts`:

```typescript
import { Connection } from "@solana/web3.js";
import { config } from "../config";
import { logger } from "../utils/logger";

let connection: Connection | null = null;

/**
 * Derive a WebSocket URL from an HTTP RPC URL if WS URL not explicitly set.
 * Helius: https://mainnet.helius-rpc.com/?api-key=KEY -> wss://mainnet.helius-rpc.com/?api-key=KEY
 */
function deriveWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

export function getWsEndpoint(): string {
  if (config.solana.wsUrl) return config.solana.wsUrl;
  return deriveWsUrl(config.solana.rpcUrl);
}

export function getConnection(): Connection {
  if (!connection) {
    const wsEndpoint = getWsEndpoint();
    connection = new Connection(config.solana.rpcUrl, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60_000,
      wsEndpoint,
    });
    logger.info("Solana connection established", {
      rpc: config.solana.rpcUrl.replace(/api-key=.*/, "api-key=***"),
      ws: wsEndpoint.replace(/api-key=.*/, "api-key=***"),
    });
  }
  return connection;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/solana/connection.ts
git commit -m "feat: add WebSocket endpoint to Solana connection"
```

---

### Task 3: Create pool-filter.ts

**Files:**
- Create: `src/filter/pool-filter.ts`
- Create: `tests/filter.test.ts`

- [ ] **Step 1: Install test deps**

```bash
cd /Users/raphael/meteora-dammv2-chainlink && npm install --save-dev vitest @types/bn.js
```

Add to `package.json` scripts: `"test": "vitest run"`

- [ ] **Step 2: Write failing tests for pool filter**

Create `tests/filter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  isSolPaired,
  isLiquidityAboveMin,
  isCreatorAllowed,
  shouldTailPool,
  FilterConfig,
  PoolCandidate,
} from "../src/filter/pool-filter";

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const RANDOM_TOKEN = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const CREATOR_A = new PublicKey("11111111111111111111111111111111");

describe("isSolPaired", () => {
  it("returns true when tokenA is SOL", () => {
    expect(isSolPaired(SOL_MINT, RANDOM_TOKEN)).toBe(true);
  });
  it("returns true when tokenB is SOL", () => {
    expect(isSolPaired(RANDOM_TOKEN, SOL_MINT)).toBe(true);
  });
  it("returns false when neither is SOL", () => {
    expect(isSolPaired(RANDOM_TOKEN, RANDOM_TOKEN)).toBe(false);
  });
});

describe("isLiquidityAboveMin", () => {
  it("returns true above threshold", () => {
    expect(isLiquidityAboveMin(2.0, 1.0)).toBe(true);
  });
  it("returns false below threshold", () => {
    expect(isLiquidityAboveMin(0.5, 1.0)).toBe(false);
  });
  it("returns true at exact threshold", () => {
    expect(isLiquidityAboveMin(1.0, 1.0)).toBe(true);
  });
});

describe("isCreatorAllowed", () => {
  const creator = CREATOR_A.toBase58();
  it("allows all when whitelist and blacklist empty", () => {
    expect(isCreatorAllowed(creator, [], [])).toBe(true);
  });
  it("blocks when on blacklist", () => {
    expect(isCreatorAllowed(creator, [], [creator])).toBe(false);
  });
  it("blocks when whitelist set but creator not on it", () => {
    expect(isCreatorAllowed(creator, ["someOtherAddr"], [])).toBe(false);
  });
  it("allows when on whitelist", () => {
    expect(isCreatorAllowed(creator, [creator], [])).toBe(true);
  });
  it("blacklist takes priority over whitelist", () => {
    expect(isCreatorAllowed(creator, [creator], [creator])).toBe(false);
  });
});

describe("shouldTailPool", () => {
  const baseCandidate: PoolCandidate = {
    poolAddress: "pool123",
    tokenAMint: SOL_MINT,
    tokenBMint: RANDOM_TOKEN,
    creator: CREATOR_A.toBase58(),
    initialLiquiditySol: 2.0,
  };
  const baseConfig: FilterConfig = {
    minPoolLiquiditySol: 1.0,
    creatorWhitelist: [],
    creatorBlacklist: [],
  };

  it("accepts valid SOL-paired pool above min liquidity", () => {
    const result = shouldTailPool(baseCandidate, baseConfig);
    expect(result.accepted).toBe(true);
  });
  it("rejects non-SOL pool", () => {
    const candidate = { ...baseCandidate, tokenAMint: RANDOM_TOKEN };
    const result = shouldTailPool(candidate, baseConfig);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("SOL");
  });
  it("rejects low liquidity", () => {
    const candidate = { ...baseCandidate, initialLiquiditySol: 0.1 };
    const result = shouldTailPool(candidate, baseConfig);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("liquidity");
  });
  it("rejects blacklisted creator", () => {
    const cfg = { ...baseConfig, creatorBlacklist: [CREATOR_A.toBase58()] };
    const result = shouldTailPool(baseCandidate, cfg);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("creator");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/raphael/meteora-dammv2-chainlink && npx vitest run tests/filter.test.ts`
Expected: FAIL — module `../src/filter/pool-filter` not found

- [ ] **Step 4: Implement pool-filter.ts**

Create `src/filter/pool-filter.ts`:

```typescript
import { PublicKey } from "@solana/web3.js";

const NATIVE_SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

export interface PoolCandidate {
  poolAddress: string;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  creator: string;
  initialLiquiditySol: number;
}

export interface FilterConfig {
  minPoolLiquiditySol: number;
  creatorWhitelist: string[];
  creatorBlacklist: string[];
}

export interface FilterResult {
  accepted: boolean;
  reason?: string;
}

export function isSolPaired(
  tokenAMint: PublicKey,
  tokenBMint: PublicKey
): boolean {
  return (
    tokenAMint.equals(NATIVE_SOL_MINT) || tokenBMint.equals(NATIVE_SOL_MINT)
  );
}

export function isLiquidityAboveMin(
  liquiditySol: number,
  minLiquiditySol: number
): boolean {
  return liquiditySol >= minLiquiditySol;
}

export function isCreatorAllowed(
  creator: string,
  whitelist: string[],
  blacklist: string[]
): boolean {
  if (blacklist.includes(creator)) return false;
  if (whitelist.length > 0 && !whitelist.includes(creator)) return false;
  return true;
}

export function shouldTailPool(
  candidate: PoolCandidate,
  filterConfig: FilterConfig
): FilterResult {
  if (!isSolPaired(candidate.tokenAMint, candidate.tokenBMint)) {
    return { accepted: false, reason: "Not SOL-paired" };
  }

  if (
    !isLiquidityAboveMin(
      candidate.initialLiquiditySol,
      filterConfig.minPoolLiquiditySol
    )
  ) {
    return {
      accepted: false,
      reason: `Below min liquidity (${candidate.initialLiquiditySol} < ${filterConfig.minPoolLiquiditySol} SOL)`,
    };
  }

  if (
    !isCreatorAllowed(
      candidate.creator,
      filterConfig.creatorWhitelist,
      filterConfig.creatorBlacklist
    )
  ) {
    return { accepted: false, reason: "Blocked creator" };
  }

  return { accepted: true };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/raphael/meteora-dammv2-chainlink && npx vitest run tests/filter.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/filter/pool-filter.ts tests/filter.test.ts package.json package-lock.json
git commit -m "feat: add pool filter with SOL-pair, liquidity, creator checks"
```

---

### Task 4: Create pool-listener.ts — WebSocket pool detection

**Files:**
- Create: `src/listener/pool-listener.ts`

- [ ] **Step 1: Implement the pool listener**

Create `src/listener/pool-listener.ts`:

```typescript
import { Connection, PublicKey, Logs, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CP_AMM_PROGRAM_ID } from "@meteora-ag/cp-amm-sdk";
import { getConnection } from "../solana/connection";
import { getPoolByAddress } from "../meteora/pools";
import { logger } from "../utils/logger";
import { PoolCandidate } from "../filter/pool-filter";

/** Log prefixes emitted by the DAMM v2 program on pool init */
const INIT_LOG_MARKERS = [
  "Program log: Instruction: InitializePool",
  "Program log: Instruction: InitializeCustomizablePool",
  "Program log: Instruction: InitializePoolWithDynamicConfig",
];

export type PoolDetectedCallback = (candidate: PoolCandidate) => Promise<void>;

export class PoolListener {
  private subscriptionId: number | null = null;
  private callbacks: PoolDetectedCallback[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000;

  onPoolDetected(cb: PoolDetectedCallback): void {
    this.callbacks.push(cb);
  }

  start(): void {
    this.subscribe();
  }

  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.subscriptionId !== null) {
      const connection = getConnection();
      connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
      logger.info("Pool listener stopped");
    }
  }

  private subscribe(): void {
    const connection = getConnection();

    logger.info("Subscribing to DAMM v2 program logs", {
      programId: CP_AMM_PROGRAM_ID.toBase58(),
    });

    this.subscriptionId = connection.onLogs(
      CP_AMM_PROGRAM_ID,
      async (logs: Logs) => {
        try {
          await this.handleLogs(logs);
        } catch (err) {
          logger.error("Error handling logs", { error: String(err) });
        }
      },
      "confirmed"
    );

    this.reconnectAttempts = 0;
    logger.info("Pool listener active — watching for new pools");
  }

  private async handleLogs(logs: Logs): Promise<void> {
    if (logs.err) return;

    const isInit = logs.logs.some((line) =>
      INIT_LOG_MARKERS.some((marker) => line.includes(marker))
    );
    if (!isInit) return;

    const txSig = logs.signature;
    logger.info("Pool initialization detected!", { txSig });

    // Fetch the full transaction to extract pool address and creator
    const connection = getConnection();
    const tx = await connection.getParsedTransaction(txSig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || !tx.meta) {
      logger.warn("Could not fetch init TX", { txSig });
      return;
    }

    // The pool address is typically a new account created in this TX.
    // Find accounts owned by CP_AMM_PROGRAM_ID in postBalances that didn't exist in preBalances.
    const accountKeys = tx.transaction.message.accountKeys;
    const creator = accountKeys[0].pubkey.toBase58(); // Fee payer = creator

    // Find the pool account: look for accounts owned by the DAMM v2 program
    // that appear in the transaction's account list
    let poolAddress: PublicKey | null = null;
    for (let i = 0; i < accountKeys.length; i++) {
      const key = accountKeys[i];
      // Post-TX owner check: if account is now owned by CP_AMM program
      // and had zero lamports pre-TX, it's the new pool
      const preBalance = tx.meta.preBalances[i];
      const postBalance = tx.meta.postBalances[i];
      if (preBalance === 0 && postBalance > 0) {
        // Verify it's actually owned by the DAMM v2 program by fetching account info
        try {
          const acctInfo = await connection.getAccountInfo(key.pubkey);
          if (acctInfo && acctInfo.owner.equals(CP_AMM_PROGRAM_ID)) {
            poolAddress = key.pubkey;
            break;
          }
        } catch {
          // Skip
        }
      }
    }

    if (!poolAddress) {
      logger.warn("Could not identify pool address from init TX", { txSig });
      return;
    }

    // Fetch pool state to get token mints and initial liquidity
    const pool = await getPoolByAddress(poolAddress);
    if (!pool) {
      logger.warn("Could not fetch new pool state", {
        poolAddress: poolAddress.toBase58(),
      });
      return;
    }

    // Estimate initial liquidity in SOL from vault balances
    const solMint = new PublicKey("So11111111111111111111111111111111111111112");
    let initialLiquiditySol = 0;
    try {
      if (pool.tokenAMint.equals(solMint)) {
        const bal = await connection.getBalance(pool.tokenAVault);
        initialLiquiditySol = bal / LAMPORTS_PER_SOL;
      } else if (pool.tokenBMint.equals(solMint)) {
        const bal = await connection.getBalance(pool.tokenBVault);
        initialLiquiditySol = bal / LAMPORTS_PER_SOL;
      }
    } catch (err) {
      logger.warn("Could not fetch vault balance for liquidity estimate", {
        error: String(err),
      });
    }

    const candidate: PoolCandidate = {
      poolAddress: poolAddress.toBase58(),
      tokenAMint: pool.tokenAMint,
      tokenBMint: pool.tokenBMint,
      creator,
      initialLiquiditySol,
    };

    logger.info("Pool candidate ready", {
      pool: poolAddress.toBase58(),
      tokenA: pool.tokenAMint.toBase58(),
      tokenB: pool.tokenBMint.toBase58(),
      creator,
      liquiditySol: initialLiquiditySol.toFixed(4),
    });

    for (const cb of this.callbacks) {
      try {
        await cb(candidate);
      } catch (err) {
        logger.error("Pool callback error", { error: String(err) });
      }
    }
  }

  /**
   * Called when the WebSocket disconnects. Reconnects with exponential backoff.
   */
  reconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );
    logger.warn(`WebSocket disconnected, reconnecting in ${delay}ms...`, {
      attempt: this.reconnectAttempts,
    });
    this.reconnectTimer = setTimeout(() => {
      this.subscribe();
    }, delay);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/listener/pool-listener.ts
git commit -m "feat: add WebSocket pool listener for DAMM v2 init detection"
```

---

### Task 5: Update risk/manager.ts — add max hold time exit

**Files:**
- Modify: `src/risk/manager.ts`

- [ ] **Step 1: Update risk manager with hold time and new config shape**

Replace `src/risk/manager.ts`:

```typescript
import { PublicKey } from "@solana/web3.js";
import { config } from "../config";
import {
  getOpenPositionCount,
  getTotalExposureSol,
  getOpenPositions,
  closeTrackedPosition,
  TrackedPosition,
} from "../tracker/store";
import { getPoolByAddress } from "../meteora/pools";
import { closePosition } from "../meteora/positions";
import { getWalletBalance } from "../solana/wallet";
import { logger } from "../utils/logger";

export interface RiskCheck {
  allowed: boolean;
  reason?: string;
}

export async function checkCanOpenPosition(
  positionSizeSol: number
): Promise<RiskCheck> {
  const openCount = getOpenPositionCount();
  if (openCount >= config.position.maxOpenPositions) {
    return {
      allowed: false,
      reason: `Max open positions reached (${openCount}/${config.position.maxOpenPositions})`,
    };
  }

  if (positionSizeSol > config.position.sizeSol) {
    return {
      allowed: false,
      reason: `Position (${positionSizeSol} SOL) exceeds limit (${config.position.sizeSol} SOL)`,
    };
  }

  const currentExposure = getTotalExposureSol();
  if (currentExposure + positionSizeSol > config.position.maxTotalExposureSol) {
    return {
      allowed: false,
      reason: `Total exposure (${currentExposure + positionSizeSol} SOL) exceeds limit (${config.position.maxTotalExposureSol} SOL)`,
    };
  }

  const balance = await getWalletBalance();
  const minReserve = 0.05;
  if (balance - positionSizeSol < minReserve) {
    return {
      allowed: false,
      reason: `Insufficient SOL (Balance: ${balance.toFixed(4)}, need: ${positionSizeSol} + ${minReserve} reserve)`,
    };
  }

  return { allowed: true };
}

export interface MonitorResult {
  closedPositions: TrackedPosition[];
  alerts: string[];
}

export async function monitorPositions(): Promise<MonitorResult> {
  const openPositions = getOpenPositions();
  const closedPositions: TrackedPosition[] = [];
  const alerts: string[] = [];

  for (const tracked of openPositions) {
    try {
      // 1. Check max hold time
      const openedAt = new Date(tracked.openedAt).getTime();
      const holdMinutes = (Date.now() - openedAt) / 60_000;
      if (config.risk.maxHoldMinutes > 0 && holdMinutes >= config.risk.maxHoldMinutes) {
        logger.info("Max hold time reached", {
          position: tracked.id,
          holdMinutes: holdMinutes.toFixed(1),
        });

        try {
          const pool = await getPoolByAddress(new PublicKey(tracked.poolAddress));
          if (!pool) {
            alerts.push(`⚠️ Pool ${tracked.poolAddress.substring(0, 8)}... not reachable for time exit`);
            continue;
          }
          const sig = await closePosition(
            pool,
            new PublicKey(tracked.positionAddress),
            new PublicKey(tracked.positionNftMint)
          );
          closeTrackedPosition(tracked.id, sig, "max-hold-time");
          closedPositions.push(tracked);
          alerts.push(
            `⏰ Max Hold Time: Position ${tracked.id} closed after ${holdMinutes.toFixed(0)} min`
          );
        } catch (err) {
          alerts.push(`⚠️ Time exit failed for ${tracked.id}: ${String(err)}`);
        }
        continue;
      }

      // 2. Check stop-loss and take-profit
      const pool = await getPoolByAddress(new PublicKey(tracked.poolAddress));
      if (!pool) {
        alerts.push(`⚠️ Pool ${tracked.poolAddress.substring(0, 8)}... not reachable`);
        continue;
      }

      const entryValue = tracked.entryValueSol;
      const currentValue = await estimatePositionValue(tracked, pool);
      if (currentValue === null) continue;

      const pnlPercent = ((currentValue - entryValue) / entryValue) * 100;

      // Stop-loss
      if (pnlPercent <= -config.risk.stopLossPercent) {
        logger.warn("Stop-Loss triggered", {
          position: tracked.id,
          pnlPercent: pnlPercent.toFixed(2),
        });
        try {
          const sig = await closePosition(
            pool,
            new PublicKey(tracked.positionAddress),
            new PublicKey(tracked.positionNftMint)
          );
          const pnlSol = currentValue - entryValue;
          closeTrackedPosition(tracked.id, sig, "stop-loss", pnlSol);
          closedPositions.push(tracked);
          alerts.push(
            `🔴 Stop-Loss: ${tracked.id} closed (${pnlPercent.toFixed(1)}%, ${pnlSol.toFixed(4)} SOL)`
          );
        } catch (err) {
          alerts.push(`⚠️ Stop-Loss failed for ${tracked.id}: ${String(err)}`);
        }
      }

      // Take-profit
      if (pnlPercent >= config.risk.takeProfitPercent) {
        logger.info("Take-Profit triggered", {
          position: tracked.id,
          pnlPercent: pnlPercent.toFixed(2),
        });
        try {
          const sig = await closePosition(
            pool,
            new PublicKey(tracked.positionAddress),
            new PublicKey(tracked.positionNftMint)
          );
          const pnlSol = currentValue - entryValue;
          closeTrackedPosition(tracked.id, sig, "take-profit", pnlSol);
          closedPositions.push(tracked);
          alerts.push(
            `🟢 Take-Profit: ${tracked.id} closed (+${pnlPercent.toFixed(1)}%, +${pnlSol.toFixed(4)} SOL)`
          );
        } catch (err) {
          alerts.push(`⚠️ Take-Profit failed for ${tracked.id}: ${String(err)}`);
        }
      }
    } catch (err) {
      logger.error(`Error monitoring position ${tracked.id}`, {
        error: String(err),
      });
    }
  }

  return { closedPositions, alerts };
}

export async function closeAllPositions(): Promise<string[]> {
  const openPositions = getOpenPositions();
  const results: string[] = [];

  for (const tracked of openPositions) {
    try {
      const pool = await getPoolByAddress(new PublicKey(tracked.poolAddress));
      if (!pool) {
        results.push(`❌ Pool not found: ${tracked.poolAddress}`);
        continue;
      }
      const sig = await closePosition(
        pool,
        new PublicKey(tracked.positionAddress),
        new PublicKey(tracked.positionNftMint)
      );
      closeTrackedPosition(tracked.id, sig, "manual-close-all");
      results.push(`✅ ${tracked.id} closed`);
    } catch (err) {
      results.push(`❌ ${tracked.id}: ${String(err)}`);
    }
  }

  return results;
}

async function estimatePositionValue(
  tracked: TrackedPosition,
  pool: any
): Promise<number | null> {
  try {
    // Simplified: return entry value. Production would calculate actual LP share value.
    return tracked.entryValueSol;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/risk/manager.ts
git commit -m "feat: add max hold time exit to risk manager"
```

---

### Task 6: Update telegram/bot.ts — remove alert listener, keep admin

**Files:**
- Modify: `src/telegram/bot.ts`
- Delete: `src/telegram/parser.ts`

- [ ] **Step 1: Rewrite bot.ts without alert channel logic**

Replace `src/telegram/bot.ts`:

```typescript
import { Telegraf, Context } from "telegraf";
import { config } from "../config";
import { logger } from "../utils/logger";

export class TelegramBot {
  private bot: Telegraf;
  private isRunning = false;

  constructor() {
    this.bot = new Telegraf(config.telegram.botToken);
    this.bot.catch((err: any) => {
      logger.error("Telegram bot error", { error: String(err) });
    });
  }

  async notifyAdmin(message: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(
        config.telegram.adminChatId,
        message,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      logger.error("Failed to send admin notification", {
        error: String(err),
      });
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    await this.bot.launch();
    this.isRunning = true;
    logger.info("Telegram bot started");
    await this.notifyAdmin(
      "🟢 <b>Pool Tailer gestartet</b>\nWatching for new DAMM v2 pools..."
    );
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    await this.notifyAdmin(
      "🔴 <b>Pool Tailer gestoppt</b>"
    );
    this.bot.stop("SIGTERM");
    this.isRunning = false;
    logger.info("Telegram bot stopped");
  }

  registerCommand(
    command: string,
    handler: (ctx: Context) => Promise<void>
  ): void {
    this.bot.command(command, async (ctx) => {
      if (ctx.chat?.id?.toString() !== config.telegram.adminChatId) return;
      await handler(ctx);
    });
  }
}
```

- [ ] **Step 2: Delete parser.ts**

```bash
rm src/telegram/parser.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/telegram/bot.ts
git rm src/telegram/parser.ts
git commit -m "feat: simplify telegram bot — remove alert listener, keep admin commands"
```

---

### Task 7: Rewrite index.ts — new orchestration

**Files:**
- Rewrite: `src/index.ts`

- [ ] **Step 1: Rewrite the main entry point**

Replace `src/index.ts`:

```typescript
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "./config";
import { logger } from "./utils/logger";
import { TelegramBot } from "./telegram/bot";
import { PoolListener } from "./listener/pool-listener";
import {
  shouldTailPool,
  PoolCandidate,
  FilterConfig,
} from "./filter/pool-filter";
import { getWallet, getWalletBalance } from "./solana/wallet";
import { getPoolByAddress } from "./meteora/pools";
import { openPosition } from "./meteora/positions";
import {
  checkCanOpenPosition,
  monitorPositions,
  closeAllPositions,
} from "./risk/manager";
import {
  addPosition,
  getOpenPositions,
  getAllPositions,
  getTotalPnl,
  getTotalExposureSol,
} from "./tracker/store";

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let telegramBot: TelegramBot;
let poolListener: PoolListener;

/**
 * Handle a newly detected pool candidate.
 */
async function handleNewPool(candidate: PoolCandidate): Promise<void> {
  logger.info("Evaluating new pool", {
    pool: candidate.poolAddress,
    creator: candidate.creator,
    liquiditySol: candidate.initialLiquiditySol.toFixed(4),
  });

  // Apply filters
  const filterConfig: FilterConfig = {
    minPoolLiquiditySol: config.filter.minPoolLiquiditySol,
    creatorWhitelist: config.filter.creatorWhitelist,
    creatorBlacklist: config.filter.creatorBlacklist,
  };
  const filterResult = shouldTailPool(candidate, filterConfig);
  if (!filterResult.accepted) {
    logger.info("Pool rejected by filter", {
      pool: candidate.poolAddress,
      reason: filterResult.reason,
    });
    return;
  }

  // Risk check
  const positionSizeSol = config.position.sizeSol;
  const riskCheck = await checkCanOpenPosition(positionSizeSol);
  if (!riskCheck.allowed) {
    await telegramBot.notifyAdmin(
      `🚫 <b>Position rejected</b>\n` +
        `Pool: <code>${candidate.poolAddress}</code>\n` +
        `Reason: ${riskCheck.reason}`
    );
    return;
  }

  // Open position
  const poolAddress = new PublicKey(candidate.poolAddress);
  const pool = await getPoolByAddress(poolAddress);
  if (!pool) {
    logger.error("Could not fetch pool for position opening", {
      pool: candidate.poolAddress,
    });
    return;
  }

  const solLamports = new BN(positionSizeSol * LAMPORTS_PER_SOL);
  const halfSol = solLamports.div(new BN(2));

  try {
    await telegramBot.notifyAdmin(
      `⏳ <b>Opening position...</b>\n` +
        `Pool: <code>${candidate.poolAddress}</code>\n` +
        `Creator: <code>${candidate.creator}</code>\n` +
        `Liquidity: ${candidate.initialLiquiditySol.toFixed(2)} SOL\n` +
        `Size: ${positionSizeSol} SOL`
    );

    const result = await openPosition(pool, halfSol, halfSol);

    const tracked = addPosition({
      poolAddress: poolAddress.toBase58(),
      positionAddress: result.positionAddress.toBase58(),
      positionNftMint: result.positionNftMint.toBase58(),
      tokenAMint: pool.tokenAMint.toBase58(),
      tokenBMint: pool.tokenBMint.toBase58(),
      tokenAAmount: result.tokenAAmount.toString(),
      tokenBAmount: result.tokenBAmount.toString(),
      entryValueSol: positionSizeSol,
      openedAt: new Date().toISOString(),
      txSignature: result.txSignature,
    });

    await telegramBot.notifyAdmin(
      `✅ <b>Position opened!</b>\n` +
        `ID: <code>${tracked.id}</code>\n` +
        `Pool: <code>${candidate.poolAddress}</code>\n` +
        `Position: <code>${result.positionAddress.toBase58()}</code>\n` +
        `Size: ${positionSizeSol} SOL\n` +
        `TX: <code>${result.txSignature}</code>\n` +
        `SL: -${config.risk.stopLossPercent}% | TP: +${config.risk.takeProfitPercent}% | Max: ${config.risk.maxHoldMinutes}min`
    );
  } catch (err) {
    logger.error("Failed to open position", { error: String(err) });
    await telegramBot.notifyAdmin(
      `❌ <b>Position failed</b>\n` +
        `Pool: <code>${candidate.poolAddress}</code>\n` +
        `Error: <code>${String(err)}</code>`
    );
  }
}

function startMonitor(): void {
  if (monitorInterval) return;

  monitorInterval = setInterval(async () => {
    try {
      const result = await monitorPositions();
      for (const alert of result.alerts) {
        await telegramBot.notifyAdmin(alert);
      }
    } catch (err) {
      logger.error("Monitor loop error", { error: String(err) });
    }
  }, config.monitor.intervalSeconds * 1000);

  logger.info("Position monitor started", {
    intervalSeconds: config.monitor.intervalSeconds,
  });
}

function stopMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    logger.info("Position monitor stopped");
  }
}

function registerAdminCommands(): void {
  telegramBot.registerCommand("status", async (ctx) => {
    const balance = await getWalletBalance();
    const openPos = getOpenPositions();
    const totalPnl = getTotalPnl();
    const exposure = getTotalExposureSol();

    await ctx.reply(
      `📊 <b>Pool Tailer Status</b>\n\n` +
        `💰 Balance: ${balance.toFixed(4)} SOL\n` +
        `📈 Open Positions: ${openPos.length}/${config.position.maxOpenPositions}\n` +
        `💵 Exposure: ${exposure.toFixed(4)}/${config.position.maxTotalExposureSol} SOL\n` +
        `📉 Total P&L: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL\n` +
        `⚙️ Position Size: ${config.position.sizeSol} SOL\n` +
        `🔍 Min Liquidity: ${config.filter.minPoolLiquiditySol} SOL\n` +
        `🛑 SL: -${config.risk.stopLossPercent}% | TP: +${config.risk.takeProfitPercent}% | Hold: ${config.risk.maxHoldMinutes}min`,
      { parse_mode: "HTML" }
    );
  });

  telegramBot.registerCommand("positions", async (ctx) => {
    const openPos = getOpenPositions();
    if (openPos.length === 0) {
      await ctx.reply("📭 No open positions.");
      return;
    }

    let msg = `📋 <b>Open Positions (${openPos.length})</b>\n\n`;
    for (const pos of openPos) {
      const holdMin = ((Date.now() - new Date(pos.openedAt).getTime()) / 60_000).toFixed(0);
      msg +=
        `<b>${pos.id}</b>\n` +
        `  Pool: <code>${pos.poolAddress.substring(0, 12)}...</code>\n` +
        `  Size: ${pos.entryValueSol} SOL\n` +
        `  Hold: ${holdMin}min / ${config.risk.maxHoldMinutes}min\n\n`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  });

  telegramBot.registerCommand("balance", async (ctx) => {
    const wallet = getWallet();
    const balance = await getWalletBalance();
    await ctx.reply(
      `💰 <b>Wallet</b>\n` +
        `Address: <code>${wallet.publicKey.toBase58()}</code>\n` +
        `Balance: ${balance.toFixed(4)} SOL`,
      { parse_mode: "HTML" }
    );
  });

  telegramBot.registerCommand("closeall", async (ctx) => {
    const openPos = getOpenPositions();
    if (openPos.length === 0) {
      await ctx.reply("📭 No open positions to close.");
      return;
    }
    await ctx.reply(`⏳ Closing ${openPos.length} position(s)...`);
    const results = await closeAllPositions();
    await ctx.reply(
      `📋 <b>Results:</b>\n` + results.join("\n"),
      { parse_mode: "HTML" }
    );
  });

  telegramBot.registerCommand("history", async (ctx) => {
    const allPos = getAllPositions().filter((p) => p.status === "closed");
    if (allPos.length === 0) {
      await ctx.reply("📭 No closed positions.");
      return;
    }

    const last10 = allPos.slice(-10);
    let msg = `📋 <b>Last ${last10.length} closed positions</b>\n\n`;
    for (const pos of last10) {
      const pnl = pos.pnlSol !== undefined
        ? `${pos.pnlSol >= 0 ? "+" : ""}${pos.pnlSol.toFixed(4)} SOL`
        : "N/A";
      msg +=
        `<b>${pos.id}</b>\n` +
        `  Reason: ${pos.closeReason}\n` +
        `  P&L: ${pnl}\n` +
        `  Closed: ${pos.closedAt || "N/A"}\n\n`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  });
}

async function main(): Promise<void> {
  logger.info("=== Meteora DAMM v2 Pool Tailer ===");
  logger.info("Starting up...");

  // Validate wallet
  const wallet = getWallet();
  const balance = await getWalletBalance();
  logger.info(`Wallet: ${wallet.publicKey.toBase58()}`);
  logger.info(`Balance: ${balance.toFixed(4)} SOL`);

  if (balance < 0.1) {
    logger.warn("Low wallet balance! Consider adding more SOL.");
  }

  // Initialize Telegram bot
  telegramBot = new TelegramBot();
  registerAdminCommands();
  await telegramBot.start();

  // Start pool listener (WebSocket)
  poolListener = new PoolListener();
  poolListener.onPoolDetected(handleNewPool);
  poolListener.start();

  // Start position monitor
  startMonitor();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    poolListener.stop();
    stopMonitor();
    await telegramBot.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("Pool Tailer running. Watching for new DAMM v2 pools...");
}

main().catch((err) => {
  logger.error("Fatal error", { error: String(err) });
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: rewrite index.ts — WebSocket pool listener orchestration"
```

---

### Task 8: Update .env.example and cleanup

**Files:**
- Rewrite: `.env.example`
- Modify: `ecosystem.config.js`

- [ ] **Step 1: Rewrite .env.example**

```
# === Solana ===
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SOLANA_SEED_PHRASE=word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12

# === Position ===
POSITION_SIZE_SOL=0.5
MAX_OPEN_POSITIONS=10
MAX_TOTAL_EXPOSURE_SOL=5.0

# === Filters ===
MIN_POOL_LIQUIDITY_SOL=1.0
CREATOR_WHITELIST=
CREATOR_BLACKLIST=

# === Risk ===
STOP_LOSS_PERCENT=20
TAKE_PROFIT_PERCENT=50
MAX_HOLD_MINUTES=60

# === Monitoring ===
MONITOR_INTERVAL_SECONDS=30

# === Telegram ===
TELEGRAM_BOT_TOKEN=123456789:ABCDefGhIjKlMnOpQrStUvWxYz
TELEGRAM_ADMIN_CHAT_ID=123456789

# === Logging ===
LOG_LEVEL=info
```

- [ ] **Step 2: Update ecosystem.config.js name**

Change the app name from `meteora-dammv2-alert-bot` to `meteora-dammv2-pool-tailer`.

- [ ] **Step 3: Commit**

```bash
git add .env.example ecosystem.config.js
git commit -m "chore: update .env.example and pm2 config for pool tailer"
```

---

### Task 9: Build and verify compilation

**Files:** All

- [ ] **Step 1: Run TypeScript compiler**

```bash
cd /Users/raphael/meteora-dammv2-chainlink && npx tsc --noEmit
```

Fix any type errors that come up.

- [ ] **Step 2: Run tests**

```bash
cd /Users/raphael/meteora-dammv2-chainlink && npx vitest run
```

All tests should pass.

- [ ] **Step 3: Build**

```bash
cd /Users/raphael/meteora-dammv2-chainlink && npm run build
```

Should compile to `dist/` without errors.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: fix any remaining type errors, ensure clean build"
```
