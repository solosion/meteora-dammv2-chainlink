import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { getCpAmm } from "./client";
import { getConnection } from "../solana/connection";
import { logger } from "../utils/logger";

// Token2022 program ID
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

export interface PoolInfo {
  address: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  sqrtPrice: BN;
  sqrtMinPrice: BN;
  sqrtMaxPrice: BN;
  liquidity: BN;
  tokenAProgram: PublicKey;
  tokenBProgram: PublicKey;
}

/**
 * Determine the token program for a given mint by checking account owner.
 */
async function resolveTokenProgram(mint: PublicKey): Promise<PublicKey> {
  try {
    const connection = getConnection();
    const accountInfo = await connection.getAccountInfo(mint);
    if (accountInfo && accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return TOKEN_2022_PROGRAM_ID;
    }
  } catch {
    // Default to standard SPL Token
  }
  return TOKEN_PROGRAM_ID;
}

/**
 * Fetch pool state by direct pool address.
 */
export async function getPoolByAddress(
  poolAddress: PublicKey
): Promise<PoolInfo | null> {
  try {
    const cpAmm = getCpAmm();
    const pool = await cpAmm.fetchPoolState(poolAddress);
    if (!pool) return null;

    const tokenAProgram = await resolveTokenProgram(pool.tokenAMint);
    const tokenBProgram = await resolveTokenProgram(pool.tokenBMint);

    return {
      address: poolAddress,
      tokenAMint: pool.tokenAMint,
      tokenBMint: pool.tokenBMint,
      tokenAVault: pool.tokenAVault,
      tokenBVault: pool.tokenBVault,
      sqrtPrice: pool.sqrtPrice,
      sqrtMinPrice: pool.sqrtMinPrice,
      sqrtMaxPrice: pool.sqrtMaxPrice,
      liquidity: pool.liquidity,
      tokenAProgram,
      tokenBProgram,
    };
  } catch (err) {
    logger.error(`Failed to fetch pool ${poolAddress.toBase58()}`, {
      error: String(err),
    });
    return null;
  }
}

/**
 * Search for DAMM v2 pools containing a specific token.
 * Returns the pool with the highest liquidity.
 */
export async function findPoolForToken(
  tokenMint: PublicKey
): Promise<PoolInfo | null> {
  try {
    const cpAmm = getCpAmm();

    // Try fetching pools by tokenAMint first
    let matchingPools = await cpAmm.fetchPoolStatesByTokenAMint(tokenMint);

    // Also try as tokenB if no results
    if (matchingPools.length === 0) {
      const allPools = await cpAmm.getAllPools();
      matchingPools = allPools.filter(
        (p) =>
          p.account.tokenAMint.equals(tokenMint) ||
          p.account.tokenBMint.equals(tokenMint)
      );
    }

    if (matchingPools.length === 0) {
      logger.warn(`No DAMM v2 pool found for token ${tokenMint.toBase58()}`);
      return null;
    }

    // Sort by liquidity descending — pick the most liquid pool
    matchingPools.sort((a, b) => {
      if (a.account.liquidity.gt(b.account.liquidity)) return -1;
      if (a.account.liquidity.lt(b.account.liquidity)) return 1;
      return 0;
    });

    const best = matchingPools[0];
    logger.info(
      `Found ${matchingPools.length} pool(s) for token ${tokenMint.toBase58()}`
    );

    const tokenAProgram = await resolveTokenProgram(best.account.tokenAMint);
    const tokenBProgram = await resolveTokenProgram(best.account.tokenBMint);

    return {
      address: best.publicKey,
      tokenAMint: best.account.tokenAMint,
      tokenBMint: best.account.tokenBMint,
      tokenAVault: best.account.tokenAVault,
      tokenBVault: best.account.tokenBVault,
      sqrtPrice: best.account.sqrtPrice,
      sqrtMinPrice: best.account.sqrtMinPrice,
      sqrtMaxPrice: best.account.sqrtMaxPrice,
      liquidity: best.account.liquidity,
      tokenAProgram,
      tokenBProgram,
    };
  } catch (err) {
    logger.error(`Failed to find pool for token ${tokenMint.toBase58()}`, {
      error: String(err),
    });
    return null;
  }
}
