/**
 * Common types for price feeds.
 */

export interface PriceUpdate {
  symbol: string;
  price: number;
  timestamp: number;
  source: "binance" | "polymarket";
}

export interface MarketUpdate {
  /** Polymarket condition token ID or slug */
  marketId: string;
  /** Market question/title */
  question: string;
  /** Outcome prices (probabilities), e.g. { "Yes": 0.65, "No": 0.35 } */
  outcomes: Record<string, number>;
  /** Total volume in USD */
  volume: number;
  /** Liquidity available */
  liquidity: number;
  timestamp: number;
  source: "polymarket";
}

export type PriceCallback = (update: PriceUpdate) => void;
export type MarketCallback = (update: MarketUpdate) => void;

export interface PriceFeed {
  start(): Promise<void>;
  stop(): Promise<void>;
  getPrice(symbol: string): number | null;
  onPrice(callback: PriceCallback): void;
  readonly isConnected: boolean;
}

export interface MarketFeed {
  start(): Promise<void>;
  stop(): Promise<void>;
  getMarket(marketId: string): MarketUpdate | null;
  onMarket(callback: MarketCallback): void;
  readonly isConnected: boolean;
}
