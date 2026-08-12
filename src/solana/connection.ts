import { Connection } from "@solana/web3.js";
import { config } from "../config";
import { logger } from "../utils/logger";

let connection: Connection | null = null;

/**
 * Derive a WebSocket URL from an HTTP RPC URL if WS URL not explicitly set.
 * Helius: https://mainnet.helius-rpc.com/?api-key=KEY -> wss://mainnet.helius-rpc.com/?api-key=KEY
 */
function deriveWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

export function getWsEndpoint(): string {
  if (config.solana.wsUrl) return config.solana.wsUrl;
  return deriveWsUrl(config.solana.rpcUrl);
}

export function getConnection(): Connection {
  if (!connection) {
    const wsEndpoint = getWsEndpoint();
    connection = new Connection(config.solana.rpcUrl, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60_000,
      wsEndpoint,
    });
    logger.info("Solana connection established", {
      rpc: config.solana.rpcUrl.replace(/api-key=.*/, "api-key=***"),
      ws: wsEndpoint.replace(/api-key=.*/, "api-key=***"),
    });
  }
  return connection;
}
