import { PublicKey, Logs } from "@solana/web3.js";
import { getConnection } from "../solana/connection";
import { logger } from "../utils/logger";
import { analyzeDlmmPosition } from "../dlmm-buywall/analyzer";
import { DlmmPositionSnapshot } from "../dlmm-buywall/types";

const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

// First 8 bytes of sha256("account:PositionV2") — Anchor discriminator.
const POSITION_V2_DISCRIMINATOR = Buffer.from([117, 176, 212, 199, 245, 180, 133, 182]);

const EVENT_MARKERS = [
  "Program log: Instruction: InitializePosition",
  "Program log: Instruction: InitializePosition2",
  "Program log: Instruction: InitializePositionByOperator",
  "Program log: Instruction: InitializePositionPda",
  "Program log: Instruction: AddLiquidityByStrategy",
  "Program log: Instruction: AddLiquidityByStrategy2",
  "Program log: Instruction: AddLiquidityByStrategyOneSide",
  "Program log: Instruction: AddLiquidity",
  "Program log: Instruction: AddLiquidity2",
];

const DEDUP_CACHE_SIZE = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const HEARTBEAT_SILENCE_MS = 120_000;

export function isDlmmPositionEventLogBatch(logs: string[]): boolean {
  return logs.some((line) => EVENT_MARKERS.some((m) => line.includes(m)));
}

export type DlmmSnapshotCallback = (s: DlmmPositionSnapshot) => Promise<void>;

export class DlmmPositionListener {
  private subscriptionId: number | null = null;
  private callbacks: DlmmSnapshotCallback[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private lastLogTime = Date.now();
  private recentTxSigs = new Set<string>();
  private recentTxOrder: string[] = [];

  onPositionSnapshot(cb: DlmmSnapshotCallback): void {
    this.callbacks.push(cb);
  }

  start(): void {
    this.stopped = false;
    this.subscribe();
    this.startHeartbeat();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.subscriptionId !== null) {
      getConnection().removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
      logger.info("DLMM position listener stopped");
    }
  }

  private subscribe(): void {
    const connection = getConnection();
    logger.info("Subscribing to DLMM program logs", { programId: DLMM_PROGRAM_ID.toBase58() });
    this.subscriptionId = connection.onLogs(
      DLMM_PROGRAM_ID,
      async (logs: Logs) => {
        this.lastLogTime = Date.now();
        try {
          await this.handleLogs(logs);
        } catch (err) {
          logger.error("DLMM-listener handleLogs error", { error: String(err) });
        }
      },
      "confirmed"
    );
    this.reconnectAttempts = 0;
    this.lastLogTime = Date.now();
    logger.info("DLMM position listener active");
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const silence = Date.now() - this.lastLogTime;
      if (silence > HEARTBEAT_SILENCE_MS && !this.stopped) {
        logger.warn(`DLMM listener silent ${(silence / 1000).toFixed(0)}s, reconnecting`);
        this.reconnect();
      }
    }, 30_000);
  }

  reconnect(): void {
    if (this.stopped) return;
    if (this.subscriptionId !== null) {
      try {
        getConnection().removeOnLogsListener(this.subscriptionId);
      } catch {
        // ignore cleanup errors
      }
      this.subscriptionId = null;
    }
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    logger.warn(`DLMM WebSocket disconnected, reconnecting in ${delay}ms...`, {
      attempt: this.reconnectAttempts,
    });
    this.reconnectTimer = setTimeout(() => this.subscribe(), delay);
  }

  private trackTxSig(sig: string): boolean {
    if (this.recentTxSigs.has(sig)) return false;
    this.recentTxSigs.add(sig);
    this.recentTxOrder.push(sig);
    if (this.recentTxOrder.length > DEDUP_CACHE_SIZE) {
      const oldest = this.recentTxOrder.shift()!;
      this.recentTxSigs.delete(oldest);
    }
    return true;
  }

  private async handleLogs(logs: Logs): Promise<void> {
    if (logs.err) return;
    if (!isDlmmPositionEventLogBatch(logs.logs)) return;
    if (!this.trackTxSig(logs.signature)) return;

    const connection = getConnection();
    const tx = await connection.getParsedTransaction(logs.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || !tx.meta) return;

    const accountKeys = tx.transaction.message.accountKeys;

    // Fetch all account infos in a single RPC call instead of N sequential getAccountInfo calls.
    const pubkeys = accountKeys.map((ak) => ak.pubkey);
    const acctInfos = await connection.getMultipleAccountsInfo(pubkeys);

    // For each account in the TX owned by the DLMM program, try to decode it as a PositionV2
    // by checking the discriminator, then reading lbPair at offset 8..40 and owner at 40..72.
    for (let i = 0; i < pubkeys.length; i++) {
      const pubkey = pubkeys[i];
      const acctInfo = acctInfos[i];
      try {
        if (!acctInfo) continue;
        if (!acctInfo.owner.equals(DLMM_PROGRAM_ID)) continue;
        const data = acctInfo.data;
        if (data.length < 72) continue; // 8 disc + 32 lbPair + 32 owner
        if (!data.subarray(0, 8).equals(POSITION_V2_DISCRIMINATOR)) continue;

        let lbPair: PublicKey;
        let owner: PublicKey;
        try {
          lbPair = new PublicKey(data.subarray(8, 40));
          owner = new PublicKey(data.subarray(40, 72));
        } catch {
          continue;
        }

        const snapshot = await analyzeDlmmPosition(
          pubkey.toBase58(),
          lbPair.toBase58(),
          owner.toBase58(),
          logs.signature
        ).catch((err) => {
          logger.debug("DLMM analyzer failed for candidate", {
            error: String(err),
            candidate: pubkey.toBase58(),
          });
          return null;
        });
        if (!snapshot) continue;

        for (const cb of this.callbacks) {
          try {
            await cb(snapshot);
          } catch (err) {
            logger.error("DLMM callback error", { error: String(err) });
          }
        }
      } catch (err) {
        logger.debug("DLMM probe failed", { error: String(err), pubkey: pubkey.toBase58() });
      }
    }
  }
}
