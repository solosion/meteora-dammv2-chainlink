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
