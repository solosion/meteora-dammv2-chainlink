import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "./config";
import { logger } from "./utils/logger";
import { TelegramBot } from "./telegram/bot";
import { ParsedAlert } from "./telegram/parser";
import { getWallet, getWalletBalance } from "./solana/wallet";
import { getPoolByAddress, findPoolForToken } from "./meteora/pools";
import { openPosition } from "./meteora/positions";
import { checkCanOpenPosition, monitorPositions, closeAllPositions } from "./risk/manager";
import {
  addPosition,
  getOpenPositions,
  getAllPositions,
  getTotalPnl,
  getTotalExposureSol,
} from "./tracker/store";

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let telegramBot: TelegramBot;

/**
 * Handle an incoming alert: find pool, check risk, open position.
 */
async function handleAlert(alert: ParsedAlert): Promise<void> {
  logger.info("Processing alert", {
    tokens: alert.tokenMints.map((t) => t.toBase58()),
    pool: alert.poolAddress?.toBase58(),
  });

  // If a pool address was provided directly, use it
  if (alert.poolAddress) {
    const pool = await getPoolByAddress(alert.poolAddress);
    if (pool) {
      await processPool(alert.poolAddress);
      return;
    }

    // Pool address is not a valid DAMM v2 pool — treat it as a token mint instead
    logger.warn(
      `Address ${alert.poolAddress.toBase58()} is not a valid DAMM v2 pool, trying as token mint`
    );
    const fallbackPool = await findPoolForToken(alert.poolAddress);
    if (fallbackPool) {
      await processPool(fallbackPool.address);
      return;
    }

    await telegramBot.notifyAdmin(
      `⚠️ Adresse <code>${alert.poolAddress.toBase58()}</code> ist weder ein DAMM v2 Pool noch ein Token mit passendem Pool`
    );
    return;
  }

  // Otherwise, search for pools for each token mint
  for (const tokenMint of alert.tokenMints) {
    const pool = await findPoolForToken(tokenMint);
    if (pool) {
      await processPool(pool.address);
    } else {
      await telegramBot.notifyAdmin(
        `⚠️ Kein DAMM v2 Pool gefunden für Token <code>${tokenMint.toBase58()}</code>`
      );
    }
  }
}

/**
 * Process a specific pool: check risks and open position.
 */
async function processPool(poolAddress: PublicKey): Promise<void> {
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
        `TX: <code>${result.txSignature}</code>\n` +
        `Stop-Loss: -${config.risk.stopLossPercent}% | Take-Profit: +${config.risk.takeProfitPercent}%`
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

      // Send alerts to admin
      for (const alert of result.alerts) {
        await telegramBot.notifyAdmin(alert);
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
        `🛑 Stop-Loss: -${config.risk.stopLossPercent}%\n` +
        `🎯 Take-Profit: +${config.risk.takeProfitPercent}%`,
      { parse_mode: "HTML" }
    );
  });

  // /positions - Show open positions
  telegramBot.registerCommand("positions", async (ctx) => {
    const openPos = getOpenPositions();
    if (openPos.length === 0) {
      await ctx.reply("📭 Keine offenen Positionen.");
      return;
    }

    let msg = `📋 <b>Offene Positionen (${openPos.length})</b>\n\n`;
    for (const pos of openPos) {
      msg +=
        `<b>${pos.id}</b>\n` +
        `  Pool: <code>${pos.poolAddress.substring(0, 12)}...</code>\n` +
        `  Größe: ${pos.entryValueSol} SOL\n` +
        `  Eröffnet: ${new Date(pos.openedAt).toLocaleString("de-DE")}\n\n`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
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

  // Initialize Telegram bot
  telegramBot = new TelegramBot();
  telegramBot.onAlert(handleAlert);
  registerAdminCommands();

  // Start bot
  await telegramBot.start();

  // Start position monitor
  startMonitor();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    stopMonitor();
    await telegramBot.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("Bot is running. Waiting for alerts...");
}

main().catch((err) => {
  logger.error("Fatal error", { error: String(err) });
  process.exit(1);
});
