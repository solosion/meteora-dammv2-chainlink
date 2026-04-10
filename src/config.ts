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
    wsUrl: optional("SOLANA_WS_URL", ""),
    seedPhrase: required("SOLANA_SEED_PHRASE"),
  },
  position: {
    sizeSol: parseFloat(optional("POSITION_SIZE_SOL", "0.5")),
    maxOpenPositions: parseInt(optional("MAX_OPEN_POSITIONS", "10"), 10),
    maxTotalExposureSol: parseFloat(optional("MAX_TOTAL_EXPOSURE_SOL", "5.0")),
  },
  filter: {
    minPoolLiquiditySol: parseFloat(optional("MIN_POOL_LIQUIDITY_SOL", "1.0")),
    creatorWhitelist: optional("CREATOR_WHITELIST", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    creatorBlacklist: optional("CREATOR_BLACKLIST", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  swap: {
    slippageBps: parseInt(optional("SWAP_SLIPPAGE_BPS", "300"), 10),
  },
  risk: {
    stopLossPercent: parseFloat(optional("STOP_LOSS_PERCENT", "20")),
    takeProfitPercent: parseFloat(optional("TAKE_PROFIT_PERCENT", "50")),
    maxHoldMinutes: parseInt(optional("MAX_HOLD_MINUTES", "60"), 10),
  },
  monitor: {
    intervalSeconds: parseInt(optional("MONITOR_INTERVAL_SECONDS", "30"), 10),
  },
  telegram: {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    adminChatId: required("TELEGRAM_ADMIN_CHAT_ID"),
  },
  logLevel: optional("LOG_LEVEL", "info"),
};
