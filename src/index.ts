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
  getPositionsSummary,
} from "./tracker/store";
import { checkMarketCapEligibility, getTokenMarketData } from "./market/marketcap";
import { searchPoolsByToken } from "./meteora/dataapi";
import { PoolWatcher, NewPoolEvent } from "./watcher/poolwatcher";

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let telegramBot: TelegramBot;
let poolWatcher: PoolWatcher | null = null;

/**
 * Handle an incoming alert: check market cap, find pool, check risk, open position.
 */
async function handleAlert(alert: ParsedAlert): Promise<void> {
  logger.info("Processing alert", {
    tokens: alert.tokenMints.map((t) => t.toBase58()),
    pool: alert.poolAddress?.toBase58(),
  });

  // If a pool address was provided directly, use it (skip market cap check for direct pool)
  if (alert.poolAddress) {
    await processPool(alert.poolAddress);
    return;
  }

  // Otherwise, check market cap and search for pools for each token mint
  for (const tokenMint of alert.tokenMints) {
    const mintStr = tokenMint.toBase58();

    // Step 1: Check Market Cap
    const mcapCheck = await checkMarketCapEligibility(
      mintStr,
      config.risk.maxMarketCapUsd
    );

    if (!mcapCheck.eligible) {
      const mcapInfo = mcapCheck.marketData
        ? `\nToken: ${mcapCheck.marketData.symbol} (${mcapCheck.marketData.name})\n` +
          `Market Cap: $${formatUsd(mcapCheck.marketData.marketCap)}\n` +
          `Preis: $${mcapCheck.marketData.priceUsd}\n` +
          `Liquidität: $${formatUsd(mcapCheck.marketData.liquidity)}`
        : "";

      await telegramBot.notifyAdmin(
        `🚫 <b>Market Cap Check fehlgeschlagen</b>\n` +
          `Token: <code>${mintStr}</code>${mcapInfo}\n` +
          `Grund: ${mcapCheck.reason}`
      );
      continue;
    }

    const md = mcapCheck.marketData!;

    // Step 1b: Check token suffix filter (only pump/bonk tokens)
    const symbolLower = md.symbol.toLowerCase();
    const nameLower = md.name.toLowerCase();
    const allowedSuffixes = config.alertParser.allowedTokenSuffixes;
    if (allowedSuffixes.length > 0) {
      const matchesSuffix = allowedSuffixes.some(
        (suffix) => symbolLower.endsWith(suffix) || nameLower.endsWith(suffix)
      );
      if (!matchesSuffix) {
        await telegramBot.notifyAdmin(
          `🚫 <b>Token-Filter</b>\n` +
            `Token: ${md.symbol} (${md.name})\n` +
            `Nur Tokens mit Suffix [${allowedSuffixes.join(", ")}] erlaubt`
        );
        continue;
      }
    }

    await telegramBot.notifyAdmin(
      `✅ <b>Market Cap OK</b>\n` +
        `Token: ${md.symbol} (${md.name})\n` +
        `Market Cap: $${formatUsd(md.marketCap)} (Grenzwert: $${formatUsd(config.risk.maxMarketCapUsd)})\n` +
        `Preis: $${md.priceUsd}\n` +
        `Liquidität: $${formatUsd(md.liquidity)}\n` +
        `24h Volume: $${formatUsd(md.volume24h)}`
    );

    // Step 2: Check minimum liquidity
    if (md.liquidity < config.risk.minLiquidityUsd) {
      await telegramBot.notifyAdmin(
        `🚫 <b>Liquidität zu gering</b>\n` +
          `Token: ${md.symbol}\n` +
          `Liquidität: $${formatUsd(md.liquidity)} (Min: $${formatUsd(config.risk.minLiquidityUsd)})`
      );
      continue;
    }

    // Step 3: Find DAMM v2 pool - first try Data API, then SDK fallback
    let poolAddress: PublicKey | null = null;

    const apiPools = await searchPoolsByToken(mintStr);
    if (apiPools.length > 0) {
      logger.info(`Found ${apiPools.length} pool(s) via Data API for ${md.symbol}`);
      poolAddress = new PublicKey(apiPools[0].address);
    } else {
      // Fallback to SDK-based pool search
      const sdkPool = await findPoolForToken(tokenMint);
      if (sdkPool) {
        poolAddress = sdkPool.address;
      }
    }

    if (poolAddress) {
      await processPool(poolAddress, md.symbol);
    } else {
      await telegramBot.notifyAdmin(
        `⚠️ Kein DAMM v2 Pool gefunden für ${md.symbol} (<code>${mintStr}</code>)`
      );
    }
  }
}

/**
 * Handle a new pool detected by the on-chain watcher.
 * Runs the same filters as Telegram alerts: suffix, market cap, liquidity.
 */
async function handleNewPool(event: NewPoolEvent): Promise<void> {
  const poolStr = event.poolAddress.toBase58();
  logger.info("New DAMM v2 pool detected by watcher", { pool: poolStr });

  // Determine the non-SOL token to check
  const WSOL = "So11111111111111111111111111111111111111112";
  const tokenAStr = event.tokenAMint.toBase58();
  const tokenBStr = event.tokenBMint.toBase58();

  // Pick the non-SOL token for market data checks
  let targetMint = tokenAStr;
  if (tokenAStr === WSOL && tokenBStr !== WSOL) {
    targetMint = tokenBStr;
  } else if (tokenBStr === WSOL && tokenAStr !== WSOL) {
    targetMint = tokenAStr;
  } else if (tokenAStr === PublicKey.default.toBase58()) {
    // Could not extract token mints — try to load pool state
    const pool = await getPoolByAddress(event.poolAddress);
    if (pool) {
      const a = pool.tokenAMint.toBase58();
      const b = pool.tokenBMint.toBase58();
      targetMint = a === WSOL ? b : a;
    } else {
      await telegramBot.notifyAdmin(
        `🔍 Neuer Pool erkannt aber Token-Mints unbekannt\n` +
          `Pool: <code>${poolStr}</code>\n` +
          `TX: <code>${event.txSignature}</code>`
      );
      return;
    }
  }

  await telegramBot.notifyAdmin(
    `🔍 <b>Neuer DAMM v2 Pool erkannt!</b>\n` +
      `Pool: <code>${poolStr}</code>\n` +
      `Token: <code>${targetMint}</code>\n` +
      `TX: <code>${event.txSignature}</code>\n` +
      `Prüfe Filter...`
  );

  // Step 1: Get market data
  const mcapCheck = await checkMarketCapEligibility(
    targetMint,
    config.risk.maxMarketCapUsd
  );

  if (!mcapCheck.eligible) {
    const mcapInfo = mcapCheck.marketData
      ? `\nToken: ${mcapCheck.marketData.symbol} (${mcapCheck.marketData.name})\n` +
        `Market Cap: $${formatUsd(mcapCheck.marketData.marketCap)}\n` +
        `Grund: ${mcapCheck.reason}`
      : `\nGrund: ${mcapCheck.reason}`;

    await telegramBot.notifyAdmin(
      `🚫 <b>Pool-Watcher: Market Cap Check fehlgeschlagen</b>\n` +
        `Pool: <code>${poolStr}</code>${mcapInfo}`
    );
    return;
  }

  const md = mcapCheck.marketData!;

  // Step 2: Token suffix filter
  const allowedSuffixes = config.alertParser.allowedTokenSuffixes;
  if (allowedSuffixes.length > 0) {
    const symbolLower = md.symbol.toLowerCase();
    const nameLower = md.name.toLowerCase();
    const matchesSuffix = allowedSuffixes.some(
      (suffix) => symbolLower.endsWith(suffix) || nameLower.endsWith(suffix)
    );
    if (!matchesSuffix) {
      await telegramBot.notifyAdmin(
        `🚫 <b>Pool-Watcher: Token-Filter</b>\n` +
          `Token: ${md.symbol} (${md.name})\n` +
          `Nur Tokens mit Suffix [${allowedSuffixes.join(", ")}] erlaubt`
      );
      return;
    }
  }

  // Step 3: Liquidity check
  if (md.liquidity < config.risk.minLiquidityUsd) {
    await telegramBot.notifyAdmin(
      `🚫 <b>Pool-Watcher: Liquidität zu gering</b>\n` +
        `Token: ${md.symbol}\n` +
        `Liquidität: $${formatUsd(md.liquidity)} (Min: $${formatUsd(config.risk.minLiquidityUsd)})`
    );
    return;
  }

  await telegramBot.notifyAdmin(
    `✅ <b>Pool-Watcher: Alle Filter bestanden!</b>\n` +
      `Token: ${md.symbol} (${md.name})\n` +
      `Market Cap: $${formatUsd(md.marketCap)}\n` +
      `Liquidität: $${formatUsd(md.liquidity)}\n` +
      `Eröffne Position...`
  );

  // Step 4: Open position
  await processPool(event.poolAddress, md.symbol);
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
    const text = msg && "text" in msg ? msg.text : "";
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

  // Start on-chain pool watcher
  if (config.watcher.enabled) {
    poolWatcher = new PoolWatcher();
    poolWatcher.onNewPool(handleNewPool);
    poolWatcher.start();
    logger.info("On-chain pool watcher enabled");
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    stopMonitor();
    poolWatcher?.stop();
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
