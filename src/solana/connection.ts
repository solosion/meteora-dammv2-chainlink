import { Connection } from "@solana/web3.js";
import { config } from "../config";
import { logger } from "../utils/logger";

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(config.solana.rpcUrl, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60_000,
    });
    logger.info("Solana connection established", {
      rpc: config.solana.rpcUrl.replace(/api-key=.*/, "api-key=***"),
    });
  }
  return connection;
}
