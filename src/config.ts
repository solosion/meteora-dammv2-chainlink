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
    alertChatId: required("TELEGRAM_ALERT_CHAT_ID"),
    adminChatId: required("TELEGRAM_ADMIN_CHAT_ID"),
  },
  risk: {
    maxPositionSizeSol: parseFloat(optional("MAX_POSITION_SIZE_SOL", "0.5")),
    maxTotalExposureSol: parseFloat(optional("MAX_TOTAL_EXPOSURE_SOL", "5.0")),
    stopLossPercent: parseFloat(optional("STOP_LOSS_PERCENT", "20")),
    takeProfitPercent: parseFloat(optional("TAKE_PROFIT_PERCENT", "50")),
    maxOpenPositions: parseInt(optional("MAX_OPEN_POSITIONS", "10"), 10),
    maxMarketCapUsd: parseFloat(optional("MAX_MARKET_CAP_USD", "1000000")),
    minLiquidityUsd: parseFloat(optional("MIN_LIQUIDITY_USD", "5000")),
  },
  alertParser: {
    tokenRegex: optional(
      "ALERT_TOKEN_REGEX",
      "[1-9A-HJ-NP-Za-km-z]{32,44}"
    ),
    allowedSenders: optional("ALERT_ALLOWED_SENDERS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  monitor: {
    intervalSeconds: parseInt(optional("MONITOR_INTERVAL_SECONDS", "30"), 10),
  },
  logLevel: optional("LOG_LEVEL", "info"),
};
