import { logger } from "../utils/logger";

export interface TokenMarketData {
  tokenAddress: string;
  name: string;
  symbol: string;
  priceUsd: number;
  marketCap: number;
  liquidity: number;
  volume24h: number;
  priceChange24h: number;
}

/**
 * Fetch market cap and price data for a Solana token using DexScreener API.
 * DexScreener is free, no API key required, and provides reliable market data.
 */
export async function getTokenMarketData(
  tokenMint: string
): Promise<TokenMarketData | null> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
    logger.debug(`Fetching market data from DexScreener`, { tokenMint });

    const response = await fetch(url);
    if (!response.ok) {
      logger.error(`DexScreener API error: ${response.status}`, {
        tokenMint,
      });
      return null;
    }

    const data: any = await response.json();

    if (!data.pairs || data.pairs.length === 0) {
      logger.warn(`No pairs found on DexScreener for token`, { tokenMint });
      return null;
    }

    // Find the pair with the highest liquidity (preferably on Solana)
    const solanaPairs = data.pairs.filter(
      (p: any) => p.chainId === "solana"
    );
    const pairs = solanaPairs.length > 0 ? solanaPairs : data.pairs;

    // Sort by liquidity descending
    pairs.sort(
      (a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    );

    const bestPair = pairs[0];

    const marketCap =
      bestPair.marketCap ||
      bestPair.fdv ||
      0;

    return {
      tokenAddress: tokenMint,
      name: bestPair.baseToken?.name || "Unknown",
      symbol: bestPair.baseToken?.symbol || "???",
      priceUsd: parseFloat(bestPair.priceUsd) || 0,
      marketCap,
      liquidity: bestPair.liquidity?.usd || 0,
      volume24h: bestPair.volume?.h24 || 0,
      priceChange24h: bestPair.priceChange?.h24 || 0,
    };
  } catch (err) {
    logger.error("Failed to fetch market data from DexScreener", {
      tokenMint,
      error: String(err),
    });
    return null;
  }
}

/**
 * Check if a token's market cap is below the configured threshold.
 * Returns the market data if eligible, null if not.
 */
export async function checkMarketCapEligibility(
  tokenMint: string,
  maxMarketCapUsd: number
): Promise<{ eligible: boolean; marketData: TokenMarketData | null; reason?: string }> {
  const marketData = await getTokenMarketData(tokenMint);

  if (!marketData) {
    return {
      eligible: false,
      marketData: null,
      reason: "Marktdaten konnten nicht abgerufen werden",
    };
  }

  if (marketData.marketCap <= 0) {
    return {
      eligible: false,
      marketData,
      reason: "Market Cap ist unbekannt oder 0",
    };
  }

  if (marketData.marketCap > maxMarketCapUsd) {
    return {
      eligible: false,
      marketData,
      reason: `Market Cap ($${formatNumber(marketData.marketCap)}) überschreitet Grenzwert ($${formatNumber(maxMarketCapUsd)})`,
    };
  }

  return { eligible: true, marketData };
}

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}
