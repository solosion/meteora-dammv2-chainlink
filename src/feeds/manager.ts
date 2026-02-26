import { BinanceFeed, BinanceFeedConfig } from "./binance";
import { PolymarketFeed, PolymarketFeedConfig } from "./polymarket";
import { PriceUpdate, MarketUpdate, PriceCallback, MarketCallback } from "./types";
import { logger } from "../utils/logger";

export interface FeedManagerConfig {
  binance: BinanceFeedConfig;
  polymarket: PolymarketFeedConfig;
}

/**
 * Coordinates all price/market feeds, provides unified access.
 */
export class FeedManager {
  private binanceFeed: BinanceFeed;
  private polymarketFeed: PolymarketFeed;

  constructor(config: FeedManagerConfig) {
    this.binanceFeed = new BinanceFeed(config.binance);
    this.polymarketFeed = new PolymarketFeed(config.polymarket);
  }

  /**
   * Start all feeds.
   */
  async start(): Promise<void> {
    logger.info("Starting all price feeds...");

    const results = await Promise.allSettled([
      this.binanceFeed.start(),
      this.polymarketFeed.start(),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        logger.error("Feed failed to start", {
          error: String(result.reason),
        });
      }
    }

    logger.info("Feed manager started");
  }

  /**
   * Stop all feeds.
   */
  async stop(): Promise<void> {
    await Promise.allSettled([
      this.binanceFeed.stop(),
      this.polymarketFeed.stop(),
    ]);
    logger.info("Feed manager stopped");
  }

  /**
   * Get current price for a symbol from Binance (e.g. "solusdt").
   */
  getPrice(symbol: string): number | null {
    return this.binanceFeed.getPrice(symbol);
  }

  /**
   * Get SOL price in USDT.
   */
  getSolPrice(): number | null {
    return this.binanceFeed.getPrice("solusdt");
  }

  /**
   * Get a Polymarket market by slug or condition ID.
   */
  getMarket(marketId: string): MarketUpdate | null {
    return this.polymarketFeed.getMarket(marketId);
  }

  /**
   * Get all monitored Polymarket markets.
   */
  getAllMarkets(): MarketUpdate[] {
    return this.polymarketFeed.getAllMarkets();
  }

  /**
   * Register a callback for Binance price updates.
   */
  onPrice(callback: PriceCallback): void {
    this.binanceFeed.onPrice(callback);
  }

  /**
   * Register a callback for Polymarket market updates.
   */
  onMarket(callback: MarketCallback): void {
    this.polymarketFeed.onMarket(callback);
  }

  /**
   * Connection status of all feeds.
   */
  getStatus(): { binance: boolean; polymarket: boolean } {
    return {
      binance: this.binanceFeed.isConnected,
      polymarket: this.polymarketFeed.isConnected,
    };
  }

  /**
   * Format a summary of current feed data (for Telegram /status).
   */
  getStatusSummary(): string {
    const status = this.getStatus();
    const lines: string[] = [];

    lines.push(
      `Binance: ${status.binance ? "🟢 Connected" : "🔴 Disconnected"}`
    );

    const solPrice = this.getSolPrice();
    if (solPrice) {
      lines.push(`SOL/USDT: $${solPrice.toFixed(2)}`);
    }

    lines.push(
      `Polymarket: ${status.polymarket ? "🟢 Connected" : "🔴 Disconnected"}`
    );

    const markets = this.getAllMarkets();
    for (const m of markets.slice(0, 3)) {
      const topOutcome = Object.entries(m.outcomes)
        .sort(([, a], [, b]) => b - a)[0];
      if (topOutcome) {
        const [name, prob] = topOutcome;
        lines.push(
          `  ${m.question.substring(0, 40)}... → ${name} ${(prob * 100).toFixed(0)}%`
        );
      }
    }

    return lines.join("\n");
  }
}
