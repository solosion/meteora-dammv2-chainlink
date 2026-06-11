import { getTokenMarketData } from "../market/marketcap";
import { logger } from "../utils/logger";
import { DetectedDlmmBuyWall } from "./types";
import { WallRecord } from "./store";

/**
 * Best-effort enrichment of a detected wall with DexScreener market data
 * (symbol, name, price, market cap). Brand-new tokens may not be indexed
 * yet — in that case the wall is returned unenriched. Never throws.
 */
export async function enrichWall(wall: DetectedDlmmBuyWall): Promise<WallRecord> {
  const tokenMint = wall.solIsTokenY ? wall.tokenXMint : wall.tokenYMint;
  try {
    const market = await getTokenMarketData(tokenMint);
    if (!market) return { ...wall };
    return {
      ...wall,
      tokenSymbol: market.symbol,
      tokenName: market.name,
      priceUsd: market.priceUsd,
      marketCapUsd: market.marketCap,
      liquidityUsd: market.liquidity,
    };
  } catch (err) {
    logger.debug("Wall enrichment failed, continuing without market data", {
      tokenMint,
      error: String(err),
    });
    return { ...wall };
  }
}
