import { PublicKey, Logs, LAMPORTS_PER_SOL } from "@solana/web3.js";
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

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** Max number of recent TX signatures to track for dedup */
const DEDUP_CACHE_SIZE = 200;

export type PoolDetectedCallback = (candidate: PoolCandidate) => Promise<void>;

export class PoolListener {
  private subscriptionId: number | null = null;
  private callbacks: PoolDetectedCallback[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000;
  private stopped = false;
  private lastLogTime = Date.now();
  /** Dedup: track recently seen TX signatures to avoid processing the same init twice */
  private recentTxSigs = new Set<string>();
  private recentTxOrder: string[] = [];

  onPoolDetected(cb: PoolDetectedCallback): void {
    this.callbacks.push(cb);
  }

  start(): void {
    this.stopped = false;
    this.subscribe();
    this.startHeartbeat();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
        this.lastLogTime = Date.now();
        try {
          await this.handleLogs(logs);
        } catch (err) {
          logger.error("Error handling logs", { error: String(err) });
        }
      },
      "confirmed"
    );

    this.reconnectAttempts = 0;
    this.lastLogTime = Date.now();
    logger.info("Pool listener active — watching for new pools");
  }

  /**
   * Heartbeat: if no logs received for 120s, assume WS disconnected and resubscribe.
   * Meteora DAMM v2 is active enough that 120s of silence signals a dead socket.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const silenceMs = Date.now() - this.lastLogTime;
      if (silenceMs > 120_000 && !this.stopped) {
        logger.warn(
          `No logs received for ${(silenceMs / 1000).toFixed(0)}s — triggering reconnect`
        );
        this.reconnect();
      }
    }, 30_000);
  }

  private trackTxSig(txSig: string): boolean {
    if (this.recentTxSigs.has(txSig)) return false;
    this.recentTxSigs.add(txSig);
    this.recentTxOrder.push(txSig);
    if (this.recentTxOrder.length > DEDUP_CACHE_SIZE) {
      const oldest = this.recentTxOrder.shift()!;
      this.recentTxSigs.delete(oldest);
    }
    return true;
  }

  private async handleLogs(logs: Logs): Promise<void> {
    if (logs.err) return;

    const isInit = logs.logs.some((line) =>
      INIT_LOG_MARKERS.some((marker) => line.includes(marker))
    );
    if (!isInit) return;

    const txSig = logs.signature;

    // Dedup: skip if we already processed this TX
    if (!this.trackTxSig(txSig)) {
      logger.debug("Skipping duplicate TX", { txSig });
      return;
    }

    logger.info("Pool initialization detected!", { txSig });

    const connection = getConnection();
    const tx = await connection.getParsedTransaction(txSig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || !tx.meta) {
      logger.warn("Could not fetch init TX", { txSig });
      return;
    }

    const accountKeys = tx.transaction.message.accountKeys;
    const creator = accountKeys[0].pubkey.toBase58();

    // Find the pool account: new account owned by the DAMM v2 program
    let poolAddress: PublicKey | null = null;
    for (let i = 0; i < accountKeys.length; i++) {
      const preBalance = tx.meta.preBalances[i];
      const postBalance = tx.meta.postBalances[i];
      if (preBalance === 0 && postBalance > 0) {
        try {
          const acctInfo = await connection.getAccountInfo(
            accountKeys[i].pubkey
          );
          if (acctInfo && acctInfo.owner.equals(CP_AMM_PROGRAM_ID)) {
            poolAddress = accountKeys[i].pubkey;
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

    // Fetch pool state to get token mints
    const pool = await getPoolByAddress(poolAddress);
    if (!pool) {
      logger.warn("Could not fetch new pool state", {
        poolAddress: poolAddress.toBase58(),
      });
      return;
    }

    // Estimate initial SOL liquidity from vault token balance
    // Vaults are SPL token accounts (wrapped SOL), so use getTokenAccountBalance
    let initialLiquiditySol = 0;
    try {
      if (pool.tokenAMint.equals(SOL_MINT)) {
        const bal = await connection.getTokenAccountBalance(pool.tokenAVault);
        initialLiquiditySol = bal.value.uiAmount ?? 0;
      } else if (pool.tokenBMint.equals(SOL_MINT)) {
        const bal = await connection.getTokenAccountBalance(pool.tokenBVault);
        initialLiquiditySol = bal.value.uiAmount ?? 0;
      }
    } catch (err) {
      logger.warn("Could not fetch vault balance", { error: String(err) });
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

  reconnect(): void {
    if (this.stopped) return;

    // Remove old subscription
    if (this.subscriptionId !== null) {
      try {
        const connection = getConnection();
        connection.removeOnLogsListener(this.subscriptionId);
      } catch {
        // Ignore cleanup errors
      }
      this.subscriptionId = null;
    }

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
