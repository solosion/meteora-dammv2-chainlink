import WebSocket from "ws";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { logger } from "../utils/logger";
import { PriceFeed, PriceUpdate, PriceCallback } from "./types";

interface BinanceTickerMsg {
  e: string; // Event type
  s: string; // Symbol
  c: string; // Close price (last price)
  o: string; // Open price
  h: string; // High price
  l: string; // Low price
  v: string; // Volume
  E: number; // Event time
}

export interface BinanceFeedConfig {
  /** Symbols to subscribe to, e.g. ["solusdt", "btcusdt"] */
  symbols: string[];
  /** WebSocket base URL (default: wss://stream.binance.com:9443) */
  wsUrl?: string;
  /** Proxy URL (socks5://host:port or http://host:port) */
  proxyUrl?: string;
  /** Reconnect delay in ms (default: 5000) */
  reconnectDelay?: number;
  /** Max reconnect attempts (default: 10) */
  maxReconnects?: number;
}

export class BinanceFeed implements PriceFeed {
  private ws: WebSocket | null = null;
  private prices = new Map<string, PriceUpdate>();
  private callbacks: PriceCallback[] = [];
  private config: Required<BinanceFeedConfig>;
  private reconnectCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private _isConnected = false;

  constructor(feedConfig: BinanceFeedConfig) {
    this.config = {
      symbols: feedConfig.symbols.map((s) => s.toLowerCase()),
      wsUrl: feedConfig.wsUrl || "wss://stream.binance.com:9443",
      proxyUrl: feedConfig.proxyUrl || "",
      reconnectDelay: feedConfig.reconnectDelay || 5000,
      maxReconnects: feedConfig.maxReconnects || 10,
    };
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  onPrice(callback: PriceCallback): void {
    this.callbacks.push(callback);
  }

  getPrice(symbol: string): number | null {
    const update = this.prices.get(symbol.toLowerCase());
    return update ? update.price : null;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectCount = 0;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this._isConnected = false;
    logger.info("Binance feed stopped");
  }

  private connect(): void {
    if (this.stopped) return;

    // Build combined stream URL
    const streams = this.config.symbols.map((s) => `${s}@ticker`).join("/");
    const url = `${this.config.wsUrl}/stream?streams=${streams}`;

    const wsOptions: WebSocket.ClientOptions = {};

    // Configure proxy if set
    if (this.config.proxyUrl) {
      const proxyUrl = this.config.proxyUrl;
      if (proxyUrl.startsWith("socks")) {
        wsOptions.agent = new SocksProxyAgent(proxyUrl);
        logger.info("Binance WS using SOCKS proxy", {
          proxy: proxyUrl.replace(/\/\/.*@/, "//***@"),
        });
      } else if (proxyUrl.startsWith("http")) {
        wsOptions.agent = new HttpsProxyAgent(proxyUrl);
        logger.info("Binance WS using HTTP proxy", {
          proxy: proxyUrl.replace(/\/\/.*@/, "//***@"),
        });
      }
    }

    logger.info("Connecting to Binance WebSocket...", {
      url: url.substring(0, 60),
      symbols: this.config.symbols,
    });

    this.ws = new WebSocket(url, wsOptions);

    this.ws.on("open", () => {
      this._isConnected = true;
      this.reconnectCount = 0;
      logger.info("Binance WebSocket connected", {
        symbols: this.config.symbols,
      });
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const wrapper = JSON.parse(data.toString());
        // Combined stream format: { stream: "solusdt@ticker", data: {...} }
        const msg: BinanceTickerMsg = wrapper.data || wrapper;

        if (!msg.s || !msg.c) return;

        const update: PriceUpdate = {
          symbol: msg.s.toLowerCase(),
          price: parseFloat(msg.c),
          timestamp: msg.E || Date.now(),
          source: "binance",
        };

        this.prices.set(update.symbol, update);

        for (const cb of this.callbacks) {
          try {
            cb(update);
          } catch (err) {
            logger.error("Binance price callback error", {
              error: String(err),
            });
          }
        }
      } catch (err) {
        logger.debug("Binance WS parse error", { error: String(err) });
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      this._isConnected = false;
      logger.warn("Binance WebSocket closed", {
        code,
        reason: reason.toString(),
      });
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      this._isConnected = false;
      logger.error("Binance WebSocket error", { error: err.message });
      // close event will fire after error, triggering reconnect
    });

    // Binance requires ping every 10 minutes to keep connection alive
    this.ws.on("ping", () => {
      this.ws?.pong();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    if (this.reconnectCount >= this.config.maxReconnects) {
      logger.error(
        `Binance WS max reconnects (${this.config.maxReconnects}) reached, giving up`
      );
      return;
    }

    const delay =
      this.config.reconnectDelay * Math.pow(2, this.reconnectCount);
    this.reconnectCount++;

    logger.info(
      `Binance WS reconnecting in ${delay}ms (attempt ${this.reconnectCount}/${this.config.maxReconnects})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}
