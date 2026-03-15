import { logger } from "../utils/logger";

/**
 * Pool data from the DAMM v2 Data API.
 */
export interface DataApiPool {
  address: string;
  tokenAAddress: string;
  tokenBAddress: string;
  tokenASymbol: string;
  tokenBSymbol: string;
  tvl: number;
  volume24h: number;
  fees24h: number;
  poolName: string;
}

export interface DataApiPosition {
  poolAddress: string;
  positionAddress: string;
  tokenAAmount: number;
  tokenBAmount: number;
  depositedTokenA: number;
  depositedTokenB: number;
  unclaimedFeeA: number;
  unclaimedFeeB: number;
}

const BASE_URL = "https://damm-v2.datapi.meteora.ag";

/**
 * Search for DAMM v2 pools by token mint address using the Data API.
 * This is much faster than fetching all pools via the SDK.
 */
export async function searchPoolsByToken(
  tokenMint: string
): Promise<DataApiPool[]> {
  try {
    const url = `${BASE_URL}/pools?page=1&page_size=20&query=${tokenMint}&sort_by=tvl:desc`;
    logger.debug("Searching pools via Data API", { tokenMint, url });

    const response = await fetch(url);
    if (!response.ok) {
      logger.error(`Data API pools search failed: ${response.status}`);
      return [];
    }

    const data: any = await response.json();

    if (!data || !Array.isArray(data.data)) {
      logger.warn("Unexpected Data API response format for pools");
      return [];
    }

    return data.data.map((p: any) => ({
      address: p.address || p.pool_address,
      tokenAAddress: p.token_a_address || p.token_a_mint,
      tokenBAddress: p.token_b_address || p.token_b_mint,
      tokenASymbol: p.token_a_symbol || "",
      tokenBSymbol: p.token_b_symbol || "",
      tvl: p.tvl || 0,
      volume24h: p.volume_24h || p.trading_volume || 0,
      fees24h: p.fees_24h || p.total_fee || 0,
      poolName: p.name || `${p.token_a_symbol || "?"}/${p.token_b_symbol || "?"}`,
    }));
  } catch (err) {
    logger.error("Failed to search pools via Data API", {
      tokenMint,
      error: String(err),
    });
    return [];
  }
}

/**
 * Fetch single pool data from the Data API.
 */
export async function getPoolFromDataApi(
  poolAddress: string
): Promise<DataApiPool | null> {
  try {
    const url = `${BASE_URL}/pools/${poolAddress}`;
    const response = await fetch(url);

    if (!response.ok) {
      logger.error(`Data API pool fetch failed: ${response.status}`);
      return null;
    }

    const p: any = await response.json();

    return {
      address: p.address || p.pool_address || poolAddress,
      tokenAAddress: p.token_a_address || p.token_a_mint || "",
      tokenBAddress: p.token_b_address || p.token_b_mint || "",
      tokenASymbol: p.token_a_symbol || "",
      tokenBSymbol: p.token_b_symbol || "",
      tvl: p.tvl || 0,
      volume24h: p.volume_24h || p.trading_volume || 0,
      fees24h: p.fees_24h || p.total_fee || 0,
      poolName: p.name || `${p.token_a_symbol || "?"}/${p.token_b_symbol || "?"}`,
    };
  } catch (err) {
    logger.error("Failed to fetch pool from Data API", {
      poolAddress,
      error: String(err),
    });
    return null;
  }
}

/**
 * Fetch open positions for a wallet from the Data API.
 * Useful for position value estimation.
 */
export async function getWalletOpenPositions(
  walletAddress: string,
  poolFilter?: string
): Promise<DataApiPosition[]> {
  try {
    let url = `${BASE_URL}/wallets/${walletAddress}/open_positions`;
    if (poolFilter) {
      url += `?pool=${poolFilter}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      logger.error(
        `Data API wallet positions failed: ${response.status}`
      );
      return [];
    }

    const data = await response.json();

    // The API returns positions grouped by pool
    const positions: DataApiPosition[] = [];
    if (Array.isArray(data)) {
      for (const group of data) {
        if (group.positions && Array.isArray(group.positions)) {
          for (const pos of group.positions) {
            positions.push({
              poolAddress: group.pool_address || "",
              positionAddress: pos.position_address || pos.address || "",
              tokenAAmount: pos.token_a_amount || 0,
              tokenBAmount: pos.token_b_amount || 0,
              depositedTokenA: pos.deposited_token_a || 0,
              depositedTokenB: pos.deposited_token_b || 0,
              unclaimedFeeA: pos.unclaimed_fee_a || 0,
              unclaimedFeeB: pos.unclaimed_fee_b || 0,
            });
          }
        }
      }
    }

    return positions;
  } catch (err) {
    logger.error("Failed to fetch wallet positions from Data API", {
      walletAddress,
      error: String(err),
    });
    return [];
  }
}

/**
 * Fetch closed positions for a wallet from the Data API.
 */
export async function getWalletClosedPositions(
  walletAddress: string,
  poolFilter?: string,
  limit: number = 50
): Promise<any[]> {
  try {
    let url = `${BASE_URL}/wallets/${walletAddress}/closed_positions?limit=${limit}`;
    if (poolFilter) {
      url += `&pool=${poolFilter}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      logger.error(
        `Data API closed positions failed: ${response.status}`
      );
      return [];
    }

    const data: any = await response.json();
    return data.data || data || [];
  } catch (err) {
    logger.error("Failed to fetch closed positions from Data API", {
      walletAddress,
      error: String(err),
    });
    return [];
  }
}
