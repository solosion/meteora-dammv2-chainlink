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
  },
  telegram: {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    adminChatId: required("TELEGRAM_ADMIN_CHAT_ID"),
  },
  dlmmBuywall: {
    enabled: optional("DLMM_BUYWALL_ENABLED", "true").toLowerCase() === "true",
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
  logLevel: optional("LOG_LEVEL", "info"),
};
