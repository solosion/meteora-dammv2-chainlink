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
      if (
        config.risk.maxHoldMinutes > 0 &&
        holdMinutes >= config.risk.maxHoldMinutes
      ) {
        logger.info("Max hold time reached", {
          position: tracked.id,
          holdMinutes: holdMinutes.toFixed(1),
        });

        try {
          const pool = await getPoolByAddress(
            new PublicKey(tracked.poolAddress)
          );
          if (!pool) {
            alerts.push(
              `\u26a0\ufe0f Pool ${tracked.poolAddress.substring(0, 8)}... not reachable for time exit`
            );
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
            `\u23f0 Max Hold Time: Position ${tracked.id} closed after ${holdMinutes.toFixed(0)} min`
          );
        } catch (err) {
          alerts.push(
            `\u26a0\ufe0f Time exit failed for ${tracked.id}: ${String(err)}`
          );
        }
        continue;
      }

      // 2. Check stop-loss and take-profit
      const pool = await getPoolByAddress(
        new PublicKey(tracked.poolAddress)
      );
      if (!pool) {
        alerts.push(
          `\u26a0\ufe0f Pool ${tracked.poolAddress.substring(0, 8)}... not reachable`
        );
        continue;
      }

      const entryValue = tracked.entryValueSol;
      const currentValue = await estimatePositionValue(tracked, pool);
      if (currentValue === null) continue;

      // Round to 2 decimals to avoid floating point edge cases
      // (e.g. -19.999999999996 instead of -20.0)
      const pnlPercent = Math.round(
        ((currentValue - entryValue) / entryValue) * 10000
      ) / 100;

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
            `\ud83d\udd34 Stop-Loss: ${tracked.id} closed (${pnlPercent.toFixed(1)}%, ${pnlSol.toFixed(4)} SOL)`
          );
        } catch (err) {
          alerts.push(
            `\u26a0\ufe0f Stop-Loss failed for ${tracked.id}: ${String(err)}`
          );
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
            `\ud83d\udfe2 Take-Profit: ${tracked.id} closed (+${pnlPercent.toFixed(1)}%, +${pnlSol.toFixed(4)} SOL)`
          );
        } catch (err) {
          alerts.push(
            `\u26a0\ufe0f Take-Profit failed for ${tracked.id}: ${String(err)}`
          );
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
      const pool = await getPoolByAddress(
        new PublicKey(tracked.poolAddress)
      );
      if (!pool) {
        results.push(`\u274c Pool not found: ${tracked.poolAddress}`);
        continue;
      }
      const sig = await closePosition(
        pool,
        new PublicKey(tracked.positionAddress),
        new PublicKey(tracked.positionNftMint)
      );
      closeTrackedPosition(tracked.id, sig, "manual-close-all");
      results.push(`\u2705 ${tracked.id} closed`);
    } catch (err) {
      results.push(`\u274c ${tracked.id}: ${String(err)}`);
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
