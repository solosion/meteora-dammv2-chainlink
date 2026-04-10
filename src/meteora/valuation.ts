/**
 * valuation.ts — Estimate the current SOL value of an LP position.
 *
 * DAMM v2 positions hold liquidity units. To estimate value:
 * 1. Fetch position state (unlocked_liquidity)
 * 2. Fetch pool state (sqrtPrice, total liquidity, token mints)
 * 3. Calculate our share of token A and B amounts
 * 4. Convert to SOL value using Jupiter price (or pool ratio for SOL-paired)
 */

import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import { getCpAmm } from "./client";
import { getConnection } from "../solana/connection";
import { logger } from "../utils/logger";

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/**
 * Estimate the current SOL value of a tracked position.
 *
 * @param positionAddress - The position PDA
 * @param poolAddress - The pool address
 * @param entryValueSol - Fallback if estimation fails
 * @returns Estimated value in SOL, or null on error
 */
export async function estimatePositionValueSol(
  positionAddress: PublicKey,
  poolAddress: PublicKey,
  entryValueSol: number
): Promise<number | null> {
  try {
    const cpAmm = getCpAmm();
    const connection = getConnection();

    // Fetch pool + position state in parallel
    const [poolState, positionState] = await Promise.all([
      cpAmm.fetchPoolState(poolAddress),
      cpAmm.fetchPositionState(positionAddress),
    ]);

    if (!poolState || !positionState) {
      logger.debug("Could not fetch pool or position state for valuation");
      return entryValueSol;
    }

    // Position's liquidity (unlocked + vested)
    const posLiquidity = new Decimal(
      positionState.unlockedLiquidity.toString()
    ).plus(positionState.vestedLiquidity.toString());

    if (posLiquidity.isZero()) {
      return 0;
    }

    // Pool's total liquidity
    const poolLiquidity = new Decimal(poolState.liquidity.toString());
    if (poolLiquidity.isZero()) {
      return entryValueSol;
    }

    // Our share of the pool
    const share = posLiquidity.div(poolLiquidity);

    // Get vault balances to determine total pool value
    const isSolA = poolState.tokenAMint.equals(SOL_MINT);
    const isSolB = poolState.tokenBMint.equals(SOL_MINT);

    if (!isSolA && !isSolB) {
      // Not a SOL-paired pool, can't easily estimate
      return entryValueSol;
    }

    const solVault = isSolA ? poolState.tokenAVault : poolState.tokenBVault;
    const tokenVault = isSolA ? poolState.tokenBVault : poolState.tokenAVault;

    // Fetch vault balances
    let solInPool = 0;
    try {
      const solBal = await connection.getTokenAccountBalance(solVault);
      solInPool = solBal.value.uiAmount ?? 0;
    } catch {
      logger.debug("Could not fetch SOL vault balance");
      return entryValueSol;
    }

    // For a SOL-paired pool, total pool value in SOL ≈ 2 * SOL in pool
    // (assuming balanced pool, which is approximate but good enough for SL/TP)
    const totalPoolValueSol = solInPool * 2;

    // Our position value = share * total pool value
    const positionValueSol = share.mul(totalPoolValueSol).toNumber();

    logger.debug("Position valuation", {
      position: positionAddress.toBase58().substring(0, 12),
      share: share.toFixed(6),
      solInPool: solInPool.toFixed(4),
      totalPoolValueSol: totalPoolValueSol.toFixed(4),
      positionValueSol: positionValueSol.toFixed(4),
      entryValueSol: entryValueSol.toFixed(4),
    });

    return positionValueSol;
  } catch (err) {
    logger.warn("Position valuation failed, using entry value", {
      error: String(err),
    });
    return entryValueSol;
  }
}
