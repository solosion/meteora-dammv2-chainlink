import { logger } from "../utils/logger";
import { DlmmBuyWallStore, WallRecord } from "./store";

/**
 * Re-checks detected walls on-chain and tracks their lifecycle:
 *
 *  - active    → just detected, being watched
 *  - removed   → position gone or drained below `removedThreshold` of its
 *                original size. The support is gone — likely fake signal,
 *                exit indicator.
 *  - confirmed → still standing (≥ `confirmThreshold`) after `confirmAfterMs`.
 *                The owner is committed — signal significance increases.
 *
 * Walls older than `maxAgeMs` stop being monitored.
 */

export type StoredWall = WallRecord & { firstSeenAt: string };

/** Returns current SOL value of the wall, or null if the position is gone. */
export type WallChecker = (wall: StoredWall) => Promise<number | null>;

export interface WallMonitorEvents {
  onRemoved: (wall: StoredWall, lastKnownSol: number) => Promise<void>;
  onConfirmed: (wall: StoredWall, currentSol: number) => Promise<void>;
}

export interface WallMonitorOptions {
  /** How often a monitoring cycle runs. Default 5 min. */
  checkIntervalMs?: number;
  /** Wall counts as confirmed when still standing after this age. Default 60 min. */
  confirmAfterMs?: number;
  /** Stop monitoring walls older than this. Default 24h. */
  maxAgeMs?: number;
  /** Below this fraction of original size the wall counts as removed. Default 0.25. */
  removedThreshold?: number;
  /** Wall must keep at least this fraction to be confirmed. Default 0.75. */
  confirmThreshold?: number;
  /** Max walls re-checked per cycle (RPC budget). Default 20. */
  maxChecksPerCycle?: number;
  /** Pause between on-chain checks within a cycle. Default 250ms. */
  delayBetweenChecksMs?: number;
}

export class WallMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cycleRunning = false;
  private readonly opts: Required<WallMonitorOptions>;

  constructor(
    private store: DlmmBuyWallStore,
    private checker: WallChecker,
    private events: WallMonitorEvents,
    opts: WallMonitorOptions = {}
  ) {
    this.opts = {
      checkIntervalMs: opts.checkIntervalMs ?? 5 * 60_000,
      confirmAfterMs: opts.confirmAfterMs ?? 60 * 60_000,
      maxAgeMs: opts.maxAgeMs ?? 24 * 3600_000,
      removedThreshold: opts.removedThreshold ?? 0.25,
      confirmThreshold: opts.confirmThreshold ?? 0.75,
      maxChecksPerCycle: opts.maxChecksPerCycle ?? 20,
      delayBetweenChecksMs: opts.delayBetweenChecksMs ?? 250,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runCycle().catch((err) => {
        logger.error("Wall monitor cycle failed", { error: String(err) });
      });
    }, this.opts.checkIntervalMs);
    logger.info("Wall monitor started", {
      intervalMin: this.opts.checkIntervalMs / 60_000,
      confirmAfterMin: this.opts.confirmAfterMs / 60_000,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Wall monitor stopped");
    }
  }

  /** Walls that still need watching: not removed, not too old. */
  private wallsToCheck(now: Date): StoredWall[] {
    const cutoff = now.getTime() - this.opts.maxAgeMs;
    return this.store
      .getWalls()
      .filter((w) => {
        if (w.status === "removed") return false;
        const t = new Date(w.firstSeenAt).getTime();
        return !Number.isNaN(t) && t >= cutoff;
      })
      .slice(0, this.opts.maxChecksPerCycle);
  }

  /** One monitoring pass. Public so tests can drive it directly. */
  async runCycle(now: Date = new Date()): Promise<void> {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    try {
      for (const wall of this.wallsToCheck(now)) {
        await this.checkWall(wall, now);
        if (this.opts.delayBetweenChecksMs > 0) {
          await new Promise((r) => setTimeout(r, this.opts.delayBetweenChecksMs));
        }
      }
    } finally {
      this.cycleRunning = false;
    }
  }

  private async checkWall(wall: StoredWall, now: Date): Promise<void> {
    let currentSol: number | null;
    try {
      currentSol = await this.checker(wall);
    } catch (err) {
      // RPC hiccup — keep the wall active and retry next cycle.
      logger.debug("Wall re-check failed, will retry", {
        position: wall.positionAddress.substring(0, 12),
        error: String(err),
      });
      return;
    }

    const nowIso = now.toISOString();

    if (currentSol === null || currentSol < wall.solValue * this.opts.removedThreshold) {
      const lastKnown = currentSol ?? 0;
      this.store.updateWall(wall.positionAddress, {
        status: "removed",
        statusChangedAt: nowIso,
        lastCheckedAt: nowIso,
        currentSolValue: lastKnown,
      });
      logger.info("Buy wall removed", {
        position: wall.positionAddress.substring(0, 12),
        originalSol: wall.solValue.toFixed(1),
        currentSol: lastKnown.toFixed(1),
      });
      await this.events.onRemoved(wall, lastKnown);
      return;
    }

    const ageMs = now.getTime() - new Date(wall.firstSeenAt).getTime();
    const confirmable =
      wall.status !== "confirmed" &&
      ageMs >= this.opts.confirmAfterMs &&
      currentSol >= wall.solValue * this.opts.confirmThreshold;

    if (confirmable) {
      this.store.updateWall(wall.positionAddress, {
        status: "confirmed",
        statusChangedAt: nowIso,
        lastCheckedAt: nowIso,
        currentSolValue: currentSol,
      });
      logger.info("Buy wall confirmed (still standing)", {
        position: wall.positionAddress.substring(0, 12),
        sol: currentSol.toFixed(1),
        ageMin: Math.round(ageMs / 60_000),
      });
      await this.events.onConfirmed(wall, currentSol);
      return;
    }

    this.store.updateWall(wall.positionAddress, {
      lastCheckedAt: nowIso,
      currentSolValue: currentSol,
    });
  }
}
