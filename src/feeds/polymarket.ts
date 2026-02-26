import { logger } from "../utils/logger";
import { MarketFeed, MarketUpdate, MarketCallback } from "./types";

interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  outcomes: string; // JSON string e.g. '["Yes","No"]'
  outcomePrices: string; // JSON string e.g. '["0.65","0.35"]'
  volume: string;
  liquidity: string;
  active: boolean;
  closed: boolean;
}

export interface PolymarketFeedConfig {
  /** Market slugs or condition IDs to monitor */
  markets: string[];
  /** Polling interval in seconds (default: 30) */
  intervalSeconds?: number;
  /** Gamma API base URL */
  apiUrl?: string;
}

export class PolymarketFeed implements MarketFeed {
  private marketData = new Map<string, MarketUpdate>();
  private callbacks: MarketCallback[] = [];
  private config: Required<PolymarketFeedConfig>;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private _isConnected = false;

  constructor(feedConfig: PolymarketFeedConfig) {
    this.config = {
      markets: feedConfig.markets.filter(Boolean),
      intervalSeconds: feedConfig.intervalSeconds || 30,
      apiUrl: feedConfig.apiUrl || "https://gamma-api.polymarket.com",
    };
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  onMarket(callback: MarketCallback): void {
    this.callbacks.push(callback);
  }

  getMarket(marketId: string): MarketUpdate | null {
    // Search by slug or condition ID
    const lower = marketId.toLowerCase();
    for (const [key, val] of this.marketData) {
      if (key.toLowerCase() === lower) return val;
    }
    return null;
  }

  getAllMarkets(): MarketUpdate[] {
    return Array.from(this.marketData.values());
  }

  async start(): Promise<void> {
    if (this.config.markets.length === 0) {
      logger.info("Polymarket feed: no markets configured, skipping");
      return;
    }

    this.stopped = false;
    logger.info("Polymarket feed starting", {
      markets: this.config.markets,
      intervalSeconds: this.config.intervalSeconds,
    });

    // Initial fetch
    await this.fetchAll();

    // Start polling
    this.pollTimer = setInterval(async () => {
      if (this.stopped) return;
      try {
        await this.fetchAll();
      } catch (err) {
        logger.error("Polymarket poll error", { error: String(err) });
      }
    }, this.config.intervalSeconds * 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this._isConnected = false;
    logger.info("Polymarket feed stopped");
  }

  private async fetchAll(): Promise<void> {
    for (const market of this.config.markets) {
      try {
        await this.fetchMarket(market);
      } catch (err) {
        logger.error(`Polymarket fetch error for ${market}`, {
          error: String(err),
        });
      }
    }
  }

  private async fetchMarket(slugOrId: string): Promise<void> {
    // Try slug-based lookup first
    const url = `${this.config.apiUrl}/markets?slug=${encodeURIComponent(slugOrId)}&limit=1`;

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // Try as condition ID
      const altUrl = `${this.config.apiUrl}/markets?id=${encodeURIComponent(slugOrId)}&limit=1`;
      const altResponse = await fetch(altUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

      if (!altResponse.ok) {
        throw new Error(
          `Polymarket API error: ${response.status} ${response.statusText}`
        );
      }

      const altData: GammaMarket[] = await altResponse.json();
      if (altData.length > 0) {
        this.processMarket(altData[0], slugOrId);
      }
      return;
    }

    const data: GammaMarket[] = await response.json();
    if (data.length === 0) {
      logger.warn(`Polymarket: no market found for "${slugOrId}"`);
      return;
    }

    this.processMarket(data[0], slugOrId);
  }

  private processMarket(market: GammaMarket, lookupKey: string): void {
    let outcomeNames: string[];
    let outcomePrices: string[];

    try {
      outcomeNames = JSON.parse(market.outcomes);
      outcomePrices = JSON.parse(market.outcomePrices);
    } catch {
      logger.warn("Polymarket: could not parse outcomes", {
        id: market.id,
      });
      return;
    }

    const outcomes: Record<string, number> = {};
    for (let i = 0; i < outcomeNames.length; i++) {
      outcomes[outcomeNames[i]] = parseFloat(outcomePrices[i] || "0");
    }

    const update: MarketUpdate = {
      marketId: market.slug || market.conditionId || lookupKey,
      question: market.question,
      outcomes,
      volume: parseFloat(market.volume || "0"),
      liquidity: parseFloat(market.liquidity || "0"),
      timestamp: Date.now(),
      source: "polymarket",
    };

    this.marketData.set(lookupKey, update);
    this._isConnected = true;

    for (const cb of this.callbacks) {
      try {
        cb(update);
      } catch (err) {
        logger.error("Polymarket callback error", { error: String(err) });
      }
    }
  }
}
