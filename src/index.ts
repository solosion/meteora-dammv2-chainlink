import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "./config";
import { logger } from "./utils/logger";
import { TelegramBot } from "./telegram/bot";
import { getWallet, getWalletBalance } from "./solana/wallet";
import { getPoolByAddress } from "./meteora/pools";
import { openPosition } from "./meteora/positions";
import { checkCanOpenPosition, monitorPositions, closeAllPositions } from "./risk/manager";
import {
  addPosition,
  getOpenPositions,
  getAllPositions,
  getTotalPnl,
  getTotalExposureSol,
  getPositionsSummary,
} from "./tracker/store";
import { getTokenMarketData } from "./market/marketcap";
import { getPoolFromDataApi, DataApiPool } from "./meteora/dataapi";
import { PoolWatcher, NewPoolEvent } from "./watcher/poolwatcher";
import { DlmmPositionListener } from "./listener/dlmm-position-listener";
import { isDlmmBuyWall } from "./dlmm-buywall/filter";
import { createDlmmBuyWallStore } from "./dlmm-buywall/store";
import { formatDlmmBuyWallMessage } from "./dlmm-buywall/notifier";
import { enrichWall } from "./dlmm-buywall/enrich";
import { DlmmPositionSnapshot, DetectedDlmmBuyWall } from "./dlmm-buywall/types";
import { DashboardServer, ActivityEntry } from "./dashboard/server";
import * as path from "path";

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let telegramBot: TelegramBot;
let poolWatcher: PoolWatcher | null = null;
let dlmmListener: DlmmPositionListener | null = null;
let dashboardServer: DashboardServer | null = null;
const dlmmStore = createDlmmBuyWallStore(
  path.join(process.cwd(), "data", "dlmm-buywalls.json")
);

// In-memory ring buffer of recently analyzed positions (matched or not),
// shown on the dashboard so it's visible the bot is working.
const ACTIVITY_BUFFER_SIZE = 50;
const recentActivity: ActivityEntry[] = [];

function pushActivity(entry: ActivityEntry): void {
  recentActivity.unshift(entry);
  if (recentActivity.length > ACTIVITY_BUFFER_SIZE) recentActivity.pop();
}

/**
 * Fetch pool info from Meteora Data API with retries.
 * New pools may not be indexed immediately, so we retry a few times.
 */
async function fetchPoolDataWithRetry(
  poolAddress: string,
  maxRetries: number = 3,
  delayMs: number = 10_000
): Promise<DataApiPool | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const data = await getPoolFromDataApi(poolAddress);
    if (data && data.tokenASymbol) {
      return data;
    }
    if (attempt < maxRetries) {
      logger.info(`Pool not yet on Meteora Data API, retry ${attempt}/${maxRetries} in ${delayMs / 1000}s...`, {
        pool: poolAddress,
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
}

async function handleDlmmBuyWall(snapshot: DlmmPositionSnapshot): Promise<void> {
  if (dlmmStore.hasSeen(snapshot.positionAddress)) return;

  const verdict = isDlmmBuyWall(snapshot, {
    minSol: config.dlmmBuywall.minSol,
    direction: config.dlmmBuywall.direction,
    singleSideThreshold: config.dlmmBuywall.singleSideThreshold,
  });

  pushActivity({
    at: new Date().toISOString(),
    positionAddress: snapshot.positionAddress,
    lbPairAddress: snapshot.lbPairAddress,
    solValue: snapshot.solValue,
    matched: verdict.matched,
    reason: verdict.reason,
  });

  if (!verdict.matched) {
    logger.debug("DLMM position not a buy wall", {
      position: snapshot.positionAddress.substring(0, 12),
      reason: verdict.reason,
    });
    return;
  }

  const wall: DetectedDlmmBuyWall = { ...snapshot, matchedReason: verdict.reason };

  // Best-effort market data (symbol, market cap) — never blocks the alert
  const enriched = await enrichWall(wall);

  dlmmStore.recordWall(enriched);

  logger.info("DLMM buy wall detected", {
    position: snapshot.positionAddress,
    sol: snapshot.solValue.toFixed(2),
    token: enriched.tokenSymbol ?? "unknown",
    lbPair: snapshot.lbPairAddress,
  });
  await telegramBot.notifyAdmin(formatDlmmBuyWallMessage(enriched));
}

/**
 * Handle a new pool detected by the on-chain watcher.
 * Uses Meteora Data API for pool info (token symbols, TVL).
 * No DexScreener dependency — new pools are checked directly via Meteora.
 */
async function handleNewPool(event: NewPoolEvent): Promise<void> {
  const poolStr = event.poolAddress.toBase58();
  logger.info("New DAMM v2 pool detected by watcher", { pool: poolStr });

  await telegramBot.notifyAdmin(
    `🔍 <b>Neuer DAMM v2 Pool erkannt!</b>\n` +
      `Pool: <code>${poolStr}</code>\n` +
      `TX: <code>${event.txSignature}</code>\n` +
      `Lade Pool-Daten von Meteora...`
  );

  // Step 1: Get pool data from Meteora Data API (with retry for new pools)
  const poolData = await fetchPoolDataWithRetry(poolStr);

  // Determine token symbols — from Data API or fallback to on-chain mints
  let tokenSymbol = "???";
  let poolName = poolStr.substring(0, 8) + "...";
  let tvl = 0;

  if (poolData) {
    const WSOL = "So11111111111111111111111111111111111111112";
    // Pick the non-SOL token symbol for display
    tokenSymbol =
      poolData.tokenAAddress === WSOL
        ? poolData.tokenBSymbol
        : poolData.tokenASymbol;
    poolName = poolData.poolName;
    tvl = poolData.tvl;
  } else {
    logger.warn("Pool not found on Meteora Data API after retries, proceeding with on-chain data", {
      pool: poolStr,
    });
  }

  // Step 2: Token suffix filter (only if we have token symbols)
  const allowedSuffixes = config.watcher.allowedTokenSuffixes;
  if (allowedSuffixes.length > 0 && tokenSymbol !== "???") {
    const symbolLower = tokenSymbol.toLowerCase();
    const nameLower = poolName.toLowerCase();
    const matchesSuffix = allowedSuffixes.some(
      (suffix) => symbolLower.endsWith(suffix) || nameLower.endsWith(suffix)
    );
    if (!matchesSuffix) {
      await telegramBot.notifyAdmin(
        `🚫 <b>Pool-Watcher: Token-Filter</b>\n` +
          `Token: ${tokenSymbol} (${poolName})\n` +
          `Nur Tokens mit Suffix [${allowedSuffixes.join(", ")}] erlaubt`
      );
      return;
    }
  }

  // Step 3: TVL / Liquiditäts-Check (use Meteora TVL instead of DexScreener liquidity)
  if (poolData && tvl > 0 && tvl < config.risk.minLiquidityUsd) {
    await telegramBot.notifyAdmin(
      `🚫 <b>Pool-Watcher: TVL zu gering</b>\n` +
        `Token: ${tokenSymbol}\n` +
        `TVL: $${formatUsd(tvl)} (Min: $${formatUsd(config.risk.minLiquidityUsd)})`
    );
    return;
  }

  await telegramBot.notifyAdmin(
    `✅ <b>Pool-Watcher: Alle Filter bestanden!</b>\n` +
      `Token: ${tokenSymbol} (${poolName})\n` +
      `TVL: $${formatUsd(tvl)}\n` +
      `Eröffne Position...`
  );

  // Step 4: Open position
  await processPool(event.poolAddress, tokenSymbol);
}

function formatUsd(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

/**
 * Process a specific pool: check risks and open position.
 */
async function processPool(poolAddress: PublicKey, tokenSymbol?: string): Promise<void> {
  const pool = await getPoolByAddress(poolAddress);
  if (!pool) {
    await telegramBot.notifyAdmin(
      `❌ Pool <code>${poolAddress.toBase58()}</code> konnte nicht geladen werden`
    );
    return;
  }

  // Determine position size (use max allowed per position)
  const positionSizeSol = config.risk.maxPositionSizeSol;

  // Risk check
  const riskCheck = await checkCanOpenPosition(positionSizeSol);
  if (!riskCheck.allowed) {
    await telegramBot.notifyAdmin(
      `🚫 <b>Position abgelehnt</b>\n` +
        `Pool: <code>${poolAddress.toBase58()}</code>\n` +
        `Grund: ${riskCheck.reason}`
    );
    return;
  }

  // Calculate token amounts based on position size
  // For a balanced position, we split the SOL value between both tokens
  const solLamports = new BN(positionSizeSol * LAMPORTS_PER_SOL);
  const halfSol = solLamports.div(new BN(2));

  // For simplicity: if one side is SOL, use half for SOL and half for the other token
  // The SDK's liquidity delta calculation handles the actual split
  const maxTokenA = halfSol;
  const maxTokenB = halfSol;

  try {
    await telegramBot.notifyAdmin(
      `⏳ <b>Position wird eröffnet...</b>\n` +
        `Pool: <code>${poolAddress.toBase58()}</code>\n` +
        `Größe: ${positionSizeSol} SOL`
    );

    const result = await openPosition(pool, maxTokenA, maxTokenB);

    // Track the position
    const tracked = addPosition({
      poolAddress: poolAddress.toBase58(),
      positionAddress: result.positionAddress.toBase58(),
      positionNftMint: result.positionNftMint.toBase58(),
      tokenAMint: pool.tokenAMint.toBase58(),
      tokenBMint: pool.tokenBMint.toBase58(),
      tokenAAmount: result.tokenAAmount.toString(),
      tokenBAmount: result.tokenBAmount.toString(),
      entryValueSol: positionSizeSol,
      openedAt: new Date().toISOString(),
      txSignature: result.txSignature,
    });

    await telegramBot.notifyAdmin(
      `✅ <b>Position eröffnet!</b>\n` +
        `ID: <code>${tracked.id}</code>\n` +
        `Pool: <code>${poolAddress.toBase58()}</code>\n` +
        `Position: <code>${result.positionAddress.toBase58()}</code>\n` +
        `Größe: ${positionSizeSol} SOL\n` +
        `TX: <code>${result.txSignature}</code>`
    );
  } catch (err) {
    logger.error("Failed to open position", { error: String(err) });
    await telegramBot.notifyAdmin(
      `❌ <b>Position fehlgeschlagen</b>\n` +
        `Pool: <code>${poolAddress.toBase58()}</code>\n` +
        `Fehler: <code>${String(err)}</code>`
    );
  }
}

/**
 * Start the position monitor loop.
 */
function startMonitor(): void {
  if (monitorInterval) return;

  monitorInterval = setInterval(async () => {
    try {
      const result = await monitorPositions();

      for (const update of result.updates) {
        await telegramBot.notifyAdmin(update);
      }
    } catch (err) {
      logger.error("Monitor loop error", { error: String(err) });
    }
  }, config.monitor.intervalSeconds * 1000);

  logger.info("Position monitor started", {
    intervalSeconds: config.monitor.intervalSeconds,
  });
}

function stopMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    logger.info("Position monitor stopped");
  }
}

/**
 * Register admin Telegram commands.
 */
function registerAdminCommands(): void {
  // /status - Show bot status
  telegramBot.registerCommand("status", async (ctx) => {
    const balance = await getWalletBalance();
    const openPos = getOpenPositions();
    const totalPnl = getTotalPnl();
    const exposure = getTotalExposureSol();

    await ctx.reply(
      `📊 <b>Bot Status</b>\n\n` +
        `💰 Balance: ${balance.toFixed(4)} SOL\n` +
        `📈 Offene Positionen: ${openPos.length}/${config.risk.maxOpenPositions}\n` +
        `💵 Exposure: ${exposure.toFixed(4)}/${config.risk.maxTotalExposureSol} SOL\n` +
        `📉 Gesamt P&L: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL\n` +
        `⚙️ Max Position: ${config.risk.maxPositionSizeSol} SOL\n` +
        `📊 Max Market Cap: $${formatUsd(config.risk.maxMarketCapUsd)}\n` +
        `💧 Min Liquidität: $${formatUsd(config.risk.minLiquidityUsd)}`,
      { parse_mode: "HTML" }
    );
  });

  // /positions - Show open positions with live P&L
  telegramBot.registerCommand("positions", async (ctx) => {
    const summary = getPositionsSummary();
    await ctx.reply(summary, { parse_mode: "HTML" });
  });

  // /balance - Show wallet balance
  telegramBot.registerCommand("balance", async (ctx) => {
    const wallet = getWallet();
    const balance = await getWalletBalance();
    await ctx.reply(
      `💰 <b>Wallet</b>\n` +
        `Adresse: <code>${wallet.publicKey.toBase58()}</code>\n` +
        `Balance: ${balance.toFixed(4)} SOL`,
      { parse_mode: "HTML" }
    );
  });

  // /closeall - Close all positions
  telegramBot.registerCommand("closeall", async (ctx) => {
    const openPos = getOpenPositions();
    if (openPos.length === 0) {
      await ctx.reply("📭 Keine offenen Positionen zum Schließen.");
      return;
    }

    await ctx.reply(
      `⏳ Schließe ${openPos.length} Position(en)...`
    );

    const results = await closeAllPositions();
    await ctx.reply(
      `📋 <b>Ergebnis:</b>\n` + results.join("\n"),
      { parse_mode: "HTML" }
    );
  });

  // /mcap <token> - Check market cap for a token
  telegramBot.registerCommand("mcap", async (ctx) => {
    const msg = ctx.message;
    const text = (msg && "text" in msg ? msg.text : "") || "";
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      await ctx.reply(
        "Verwendung: /mcap <TOKEN_MINT_ADRESSE>\n" +
          "Zeigt Market Cap und Preis eines Tokens an.",
        { parse_mode: "HTML" }
      );
      return;
    }

    const tokenMint = parts[1];
    await ctx.reply("Lade Marktdaten...");

    const marketData = await getTokenMarketData(tokenMint);
    if (!marketData) {
      await ctx.reply(
        `❌ Keine Marktdaten gefunden für <code>${tokenMint}</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const eligible = marketData.marketCap <= config.risk.maxMarketCapUsd;
    await ctx.reply(
      `📊 <b>Marktdaten: ${marketData.symbol}</b>\n\n` +
        `Token: ${marketData.name}\n` +
        `Adresse: <code>${tokenMint}</code>\n` +
        `Preis: $${marketData.priceUsd}\n` +
        `Market Cap: $${formatUsd(marketData.marketCap)}\n` +
        `Liquidität: $${formatUsd(marketData.liquidity)}\n` +
        `24h Volume: $${formatUsd(marketData.volume24h)}\n` +
        `24h Änderung: ${marketData.priceChange24h >= 0 ? "+" : ""}${marketData.priceChange24h.toFixed(2)}%\n\n` +
        `Grenzwert: $${formatUsd(config.risk.maxMarketCapUsd)}\n` +
        `Status: ${eligible ? "✅ Unter Grenzwert" : "🚫 Über Grenzwert"}`,
      { parse_mode: "HTML" }
    );
  });

  // /dlmm_buywalls - Show DLMM buy wall tracker status
  telegramBot.registerCommand("dlmm_buywalls", async (ctx) => {
    const count = dlmmStore.size();
    const listenerStatus = dlmmListener?.getStatus();
    await ctx.reply(
      `🧱 <b>DLMM Buy Wall Tracker</b>\n` +
        `Aktiv: ${config.dlmmBuywall.enabled ? "✅" : "❌"}\n` +
        `WebSocket: ${listenerStatus?.active ? "✅ verbunden" : "❌ getrennt"}\n` +
        `Letztes Event: ${listenerStatus ? `vor ${listenerStatus.lastEventAgeSec}s` : "–"}\n` +
        `Min SOL: ${config.dlmmBuywall.minSol}\n` +
        `Richtung: ${config.dlmmBuywall.direction}\n` +
        `Einseitig-Schwelle: ${(config.dlmmBuywall.singleSideThreshold * 100).toFixed(0)}%\n` +
        `Walls erkannt: ${count}\n` +
        (config.dashboard.enabled
          ? `\n📊 Dashboard: Port ${config.dashboard.port} auf dem Server`
          : ""),
      { parse_mode: "HTML" }
    );
  });

  // /history - Show closed positions
  telegramBot.registerCommand("history", async (ctx) => {
    const allPos = getAllPositions().filter((p) => p.status === "closed");
    if (allPos.length === 0) {
      await ctx.reply("📭 Keine geschlossenen Positionen.");
      return;
    }

    const last10 = allPos.slice(-10);
    let msg = `📋 <b>Letzte ${last10.length} geschlossene Positionen</b>\n\n`;
    for (const pos of last10) {
      const pnl = pos.pnlSol !== undefined ? `${pos.pnlSol >= 0 ? "+" : ""}${pos.pnlSol.toFixed(4)} SOL` : "N/A";
      msg +=
        `<b>${pos.id}</b>\n` +
        `  Grund: ${pos.closeReason}\n` +
        `  P&L: ${pnl}\n` +
        `  Geschlossen: ${pos.closedAt ? new Date(pos.closedAt).toLocaleString("de-DE") : "N/A"}\n\n`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  });
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  logger.info("=== Meteora DAMM v2 Alert Bot ===");
  logger.info("Starting up...");

  // Validate wallet
  const wallet = getWallet();
  const balance = await getWalletBalance();
  logger.info(`Wallet: ${wallet.publicKey.toBase58()}`);
  logger.info(`Balance: ${balance.toFixed(4)} SOL`);

  if (balance < 0.1) {
    logger.warn("Low wallet balance! Consider adding more SOL.");
  }

  // Initialize Telegram bot (admin commands only)
  telegramBot = new TelegramBot();
  registerAdminCommands();

  // Start bot
  await telegramBot.start();

  // Start position monitor
  startMonitor();

  // Start on-chain pool watcher
  if (config.watcher.enabled) {
    poolWatcher = new PoolWatcher();
    poolWatcher.onNewPool(handleNewPool);
    poolWatcher.start();
    logger.info("On-chain pool watcher enabled");
  }

  // Start DLMM buy wall tracker
  if (config.dlmmBuywall.enabled) {
    dlmmListener = new DlmmPositionListener();
    dlmmListener.onPositionSnapshot(handleDlmmBuyWall);
    dlmmListener.start();
    logger.info("DLMM buy wall tracker enabled", {
      minSol: config.dlmmBuywall.minSol,
      direction: config.dlmmBuywall.direction,
    });
  } else {
    logger.info("DLMM buy wall tracker disabled (set DLMM_BUYWALL_ENABLED=true to enable)");
  }

  // Start web dashboard
  if (config.dashboard.enabled) {
    dashboardServer = new DashboardServer({
      store: dlmmStore,
      getListenerStatus: () => dlmmListener?.getStatus() ?? null,
      getActivity: () => recentActivity,
      config: {
        enabled: config.dlmmBuywall.enabled,
        minSol: config.dlmmBuywall.minSol,
        direction: config.dlmmBuywall.direction,
        singleSideThreshold: config.dlmmBuywall.singleSideThreshold,
      },
      authToken: config.dashboard.authToken,
    });
    dashboardServer.start(config.dashboard.port, config.dashboard.host);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    stopMonitor();
    poolWatcher?.stop();
    dlmmListener?.stop();
    dashboardServer?.stop();
    await telegramBot.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("Bot is running. Waiting for alerts...");
}

// Graceful shutdown on uncaught errors — stop Telegram bot before exiting
// to prevent 409 conflicts when the process restarts.
async function gracefulExit(reason: string, err?: unknown): Promise<void> {
  logger.error(`${reason}`, { error: err ? String(err) : "unknown" });
  try {
    stopMonitor();
    poolWatcher?.stop();
    dlmmListener?.stop();
    dashboardServer?.stop();
    if (telegramBot) await telegramBot.stop();
  } catch (cleanupErr) {
    logger.error("Error during cleanup", { error: String(cleanupErr) });
  }
  // Give Telegram API time to release the getUpdates connection
  await new Promise((resolve) => setTimeout(resolve, 2000));
  process.exit(1);
}

process.on("uncaughtException", (err) => {
  gracefulExit("Uncaught exception", err);
});

process.on("unhandledRejection", (reason) => {
  gracefulExit("Unhandled rejection", reason);
});

main().catch((err) => {
  gracefulExit("Fatal error in main()", err);
});
