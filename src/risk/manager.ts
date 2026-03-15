import { PublicKey } from "@solana/web3.js";
import { config } from "../config";
import {
  getOpenPositionCount,
  getTotalExposureSol,
  getOpenPositions,
  closeTrackedPosition,
  updatePositionValue,
  TrackedPosition,
} from "../tracker/store";
import { getPoolByAddress } from "../meteora/pools";
import { closePosition } from "../meteora/positions";
import { getWalletBalance, getWallet } from "../solana/wallet";
import { logger } from "../utils/logger";
import { getWalletOpenPositions } from "../meteora/dataapi";
import { getTokenMarketData } from "../market/marketcap";

export interface RiskCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Check if a new position can be opened given current risk parameters.
 */
export async function checkCanOpenPosition(
  positionSizeSol: number
): Promise<RiskCheck> {
  const openCount = getOpenPositionCount();
  if (openCount >= config.risk.maxOpenPositions) {
    return {
      allowed: false,
      reason: `Max offene Positionen erreicht (${openCount}/${config.risk.maxOpenPositions})`,
    };
  }

  if (positionSizeSol > config.risk.maxPositionSizeSol) {
    return {
      allowed: false,
      reason: `Position (${positionSizeSol} SOL) überschreitet Limit (${config.risk.maxPositionSizeSol} SOL)`,
    };
  }

  const currentExposure = getTotalExposureSol();
  if (currentExposure + positionSizeSol > config.risk.maxTotalExposureSol) {
    return {
      allowed: false,
      reason: `Gesamtexposure (${currentExposure + positionSizeSol} SOL) überschreitet Limit (${config.risk.maxTotalExposureSol} SOL)`,
    };
  }

  const balance = await getWalletBalance();
  const minReserve = 0.05;
  if (balance - positionSizeSol < minReserve) {
    return {
      allowed: false,
      reason: `Nicht genug SOL (Balance: ${balance.toFixed(4)}, benötigt: ${positionSizeSol} + ${minReserve} Reserve)`,
    };
  }

  return { allowed: true };
}

export interface MonitorResult {
  updates: string[];
}

/**
 * Monitor open positions: update current values and P&L for tracking.
 * No automatic closing — positions are only closed manually via /closeall.
 */
export async function monitorPositions(): Promise<MonitorResult> {
  const openPositions = getOpenPositions();
  const updates: string[] = [];

  for (const tracked of openPositions) {
    try {
      const pool = await getPoolByAddress(
        new PublicKey(tracked.poolAddress)
      );

      if (!pool) {
        updates.push(
          `⚠️ Pool ${tracked.poolAddress.substring(0, 8)}... nicht erreichbar`
        );
        continue;
      }

      const currentValue = await estimatePositionValue(tracked);

      if (currentValue !== null) {
        const pnlSol = currentValue - tracked.entryValueSol;
        const pnlPercent =
          ((currentValue - tracked.entryValueSol) / tracked.entryValueSol) *
          100;

        updatePositionValue(tracked.id, currentValue, pnlSol, pnlPercent);
      }
    } catch (err) {
      logger.error(`Error monitoring position ${tracked.id}`, {
        error: String(err),
      });
    }
  }

  return { updates };
}

/**
 * Close all open positions (emergency / manual command).
 */
export async function closeAllPositions(): Promise<string[]> {
  const openPositions = getOpenPositions();
  const results: string[] = [];

  for (const tracked of openPositions) {
    try {
      const pool = await getPoolByAddress(
        new PublicKey(tracked.poolAddress)
      );
      if (!pool) {
        results.push(`❌ Pool nicht gefunden: ${tracked.poolAddress}`);
        continue;
      }

      const sig = await closePosition(
        pool,
        new PublicKey(tracked.positionAddress),
        new PublicKey(tracked.positionNftMint)
      );

      const currentValue = await estimatePositionValue(tracked);
      const pnlSol = currentValue
        ? currentValue - tracked.entryValueSol
        : undefined;

      closeTrackedPosition(tracked.id, sig, "manual-close-all", pnlSol);
      results.push(`✅ ${tracked.id} geschlossen`);
    } catch (err) {
      results.push(`❌ ${tracked.id}: ${String(err)}`);
    }
  }

  return results;
}

/**
 * Estimate the current SOL value of a tracked position.
 */
async function estimatePositionValue(
  tracked: TrackedPosition
): Promise<number | null> {
  try {
    const wallet = getWallet();

    const apiPositions = await getWalletOpenPositions(
      wallet.publicKey.toBase58(),
      tracked.poolAddress
    );

    const apiPos = apiPositions.find(
      (p) => p.positionAddress === tracked.positionAddress
    );

    if (apiPos) {
      const tokenAData = await getTokenMarketData(tracked.tokenAMint);
      const tokenBData = await getTokenMarketData(tracked.tokenBMint);

      if (tokenAData && tokenBData) {
        const valueUsd =
          apiPos.tokenAAmount * tokenAData.priceUsd +
          apiPos.tokenBAmount * tokenBData.priceUsd;

        const solData = await getTokenMarketData(
          "So11111111111111111111111111111111111111112"
        );
        if (solData && solData.priceUsd > 0) {
          return valueUsd / solData.priceUsd;
        }
      }
    }

    return tracked.entryValueSol;
  } catch (err) {
    logger.debug("Position value estimation fallback to entry value", {
      position: tracked.id,
      error: String(err),
    });
    return tracked.entryValueSol;
  }
}
