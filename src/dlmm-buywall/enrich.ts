import { getTokenMarketData } from "../market/marketcap";
import { logger } from "../utils/logger";
import { DetectedDlmmBuyWall } from "./types";
import { WallRecord } from "./store";

// Cache SOL price for 60s — used for wall-to-volume ratio.
let cachedSolPrice = 0;
let solPriceUpdatedAt = 0;

async function getSolPriceUsd(): Promise<number> {
  if (cachedSolPrice > 0 && Date.now() - solPriceUpdatedAt < 60_000) {
    return cachedSolPrice;
  }
  try {
    const sol = await getTokenMarketData("So11111111111111111111111111111111111111112");
    if (sol && sol.priceUsd > 0) {
      cachedSolPrice = sol.priceUsd;
      solPriceUpdatedAt = Date.now();
    }
  } catch {}
  return cachedSolPrice;
}

export async function enrichWall(wall: DetectedDlmmBuyWall): Promise<WallRecord> {
  const tokenMint = wall.solIsTokenY ? wall.tokenXMint : wall.tokenYMint;
  const solPriceUsd = await getSolPriceUsd();

  try {
    const market = await getTokenMarketData(tokenMint);
    if (!market) return { ...wall, solPriceUsd };
    return {
      ...wall,
      tokenSymbol: market.symbol,
      tokenName: market.name,
      priceUsd: market.priceUsd,
      marketCapUsd: market.marketCap,
      liquidityUsd: market.liquidity,
      volume24hUsd: market.volume24h,
      priceChange24h: market.priceChange24h,
      solPriceUsd,
    };
  } catch (err) {
    logger.debug("Wall enrichment failed, continuing without market data", {
      tokenMint,
      error: String(err),
    });
    return { ...wall, solPriceUsd };
  }
}
