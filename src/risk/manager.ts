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
  // Check max open positions
  const openCount = getOpenPositionCount();
  if (openCount >= config.risk.maxOpenPositions) {
    return {
      allowed: false,
      reason: `Max offene Positionen erreicht (${openCount}/${config.risk.maxOpenPositions})`,
    };
  }

  // Check position size limit
  if (positionSizeSol > config.risk.maxPositionSizeSol) {
    return {
      allowed: false,
      reason: `Position (${positionSizeSol} SOL) überschreitet Limit (${config.risk.maxPositionSizeSol} SOL)`,
    };
  }

  // Check total exposure
  const currentExposure = getTotalExposureSol();
  if (currentExposure + positionSizeSol > config.risk.maxTotalExposureSol) {
    return {
      allowed: false,
      reason: `Gesamtexposure (${currentExposure + positionSizeSol} SOL) überschreitet Limit (${config.risk.maxTotalExposureSol} SOL)`,
    };
  }

  // Check wallet balance (keep at least 0.05 SOL for fees)
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
  closedPositions: TrackedPosition[];
  alerts: string[];
}

/**
 * Monitor open positions for stop-loss and take-profit conditions.
 * This is called periodically by the main loop.
 */
export async function monitorPositions(): Promise<MonitorResult> {
  const openPositions = getOpenPositions();
  const closedPositions: TrackedPosition[] = [];
  const alerts: string[] = [];

  for (const tracked of openPositions) {
    try {
      const pool = await getPoolByAddress(
        new PublicKey(tracked.poolAddress)
      );

      if (!pool) {
        alerts.push(
          `⚠️ Pool ${tracked.poolAddress.substring(0, 8)}... nicht erreichbar`
        );
        continue;
      }

      // Estimate current value based on pool price changes
      // This is a simplified P&L calculation
      const entryValue = tracked.entryValueSol;
      // In a real scenario, we'd calculate the current value of the position
      // by checking the current pool state and our share of liquidity.
      // For now, we use a simplified approach based on pool metrics.
      const currentValue = await estimatePositionValue(tracked, pool);

      if (currentValue === null) continue;

      const pnlPercent =
        ((currentValue - entryValue) / entryValue) * 100;

      // Check stop-loss
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
            `🔴 Stop-Loss: Position ${tracked.id} geschlossen (${pnlPercent.toFixed(1)}%, ${pnlSol.toFixed(4)} SOL)`
          );
        } catch (err) {
          alerts.push(
            `⚠️ Stop-Loss fehlgeschlagen für ${tracked.id}: ${String(err)}`
          );
        }
      }

      // Check take-profit
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
            `🟢 Take-Profit: Position ${tracked.id} geschlossen (+${pnlPercent.toFixed(1)}%, +${pnlSol.toFixed(4)} SOL)`
          );
        } catch (err) {
          alerts.push(
            `⚠️ Take-Profit fehlgeschlagen für ${tracked.id}: ${String(err)}`
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
      closeTrackedPosition(tracked.id, sig, "manual-close-all");
      results.push(`✅ ${tracked.id} geschlossen`);
    } catch (err) {
      results.push(`❌ ${tracked.id}: ${String(err)}`);
    }
  }

  return results;
}

/**
 * Estimate the current SOL value of a tracked position.
 * Uses the DAMM v2 Data API for position data and DexScreener for token prices.
 */
async function estimatePositionValue(
  tracked: TrackedPosition,
  pool: any
): Promise<number | null> {
  try {
    const wallet = getWallet();

    // Try to get position data from the Data API
    const apiPositions = await getWalletOpenPositions(
      wallet.publicKey.toBase58(),
      tracked.poolAddress
    );

    const apiPos = apiPositions.find(
      (p) => p.positionAddress === tracked.positionAddress
    );

    if (apiPos) {
      // Get current token prices to estimate USD value, then convert to SOL
      const tokenAData = await getTokenMarketData(tracked.tokenAMint);
      const tokenBData = await getTokenMarketData(tracked.tokenBMint);

      if (tokenAData && tokenBData) {
        const valueUsd =
          apiPos.tokenAAmount * tokenAData.priceUsd +
          apiPos.tokenBAmount * tokenBData.priceUsd;

        // Get SOL price for conversion
        const solData = await getTokenMarketData(
          "So11111111111111111111111111111111111111112"
        );
        if (solData && solData.priceUsd > 0) {
          return valueUsd / solData.priceUsd;
        }
      }
    }

    // Fallback: return entry value
    return tracked.entryValueSol;
  } catch (err) {
    logger.debug("Position value estimation fallback to entry value", {
      position: tracked.id,
      error: String(err),
    });
    return tracked.entryValueSol;
  }
}
