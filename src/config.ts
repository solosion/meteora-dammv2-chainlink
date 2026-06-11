import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  solana: {
    rpcUrl: required("SOLANA_RPC_URL"),
    seedPhrase: required("SOLANA_SEED_PHRASE"),
  },
  telegram: {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    adminChatId: required("TELEGRAM_ADMIN_CHAT_ID"),
  },
  risk: {
    maxPositionSizeSol: parseFloat(optional("MAX_POSITION_SIZE_SOL", "0.5")),
    maxTotalExposureSol: parseFloat(optional("MAX_TOTAL_EXPOSURE_SOL", "5.0")),
    maxOpenPositions: parseInt(optional("MAX_OPEN_POSITIONS", "10"), 10),
    maxMarketCapUsd: parseFloat(optional("MAX_MARKET_CAP_USD", "1000000")),
    minLiquidityUsd: parseFloat(optional("MIN_LIQUIDITY_USD", "0")),
  },
  watcher: {
    enabled: optional("POOL_WATCHER_ENABLED", "true") === "true",
    pollIntervalSeconds: parseInt(optional("POOL_WATCHER_INTERVAL_SECONDS", "5"), 10),
    allowedTokenSuffixes: optional("ALLOWED_TOKEN_SUFFIXES", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
  monitor: {
    intervalSeconds: parseInt(optional("MONITOR_INTERVAL_SECONDS", "30"), 10),
  },
  logLevel: optional("LOG_LEVEL", "info"),
  dlmmBuywall: {
    enabled: optional("DLMM_BUYWALL_ENABLED", "false").toLowerCase() === "true",
    minSol: parseFloat(optional("DLMM_BUYWALL_MIN_SOL", "50")),
    direction: optional("DLMM_BUYWALL_DIRECTION", "below").toLowerCase() as
      "above" | "below" | "either",
    singleSideThreshold: parseFloat(
      optional("DLMM_BUYWALL_SINGLE_SIDE_THRESHOLD", "0.95")
    ),
  },
  dashboard: {
    enabled: optional("DASHBOARD_ENABLED", "true").toLowerCase() === "true",
    port: parseInt(optional("DASHBOARD_PORT", "3000"), 10),
    host: optional("DASHBOARD_HOST", "0.0.0.0"),
    authToken: optional("DASHBOARD_AUTH_TOKEN", ""),
  },
};
