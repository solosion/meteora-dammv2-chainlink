import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import * as path from "path";
import { config } from "./config";
import { logger } from "./utils/logger";
import { TelegramBot } from "./telegram/bot";
import { PoolListener } from "./listener/pool-listener";
import { DlmmPositionListener } from "./listener/dlmm-position-listener";
import { isDlmmBuyWall } from "./dlmm-buywall/filter";
import { createDlmmBuyWallStore } from "./dlmm-buywall/store";
import { formatDlmmBuyWallMessage } from "./dlmm-buywall/notifier";
import { DlmmPositionSnapshot, DetectedDlmmBuyWall } from "./dlmm-buywall/types";
import {
  shouldTailPool,
  PoolCandidate,
  FilterConfig,
} from "./filter/pool-filter";
import { getWallet, getWalletBalance } from "./solana/wallet";
import { getPoolByAddress } from "./meteora/pools";
import { openPosition } from "./meteora/positions";
import { swapSolForToken, getTokenBalance } from "./swap/jupiter";
import {
  checkCanOpenPosition,
  monitorPositions,
  closeAllPositions,
} from "./risk/manager";
import {
  addPosition,
  getOpenPositions,
  getAllPositions,
  getTotalPnl,
  getTotalExposureSol,
} from "./tracker/store";

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let telegramBot: TelegramBot;
let poolListener: PoolListener;
let dlmmListener: DlmmPositionListener | null = null;
const dlmmStore = createDlmmBuyWallStore(
  path.join(process.cwd(), "data", "dlmm-buywalls.json")
);

async function handleDlmmBuyWall(snapshot: DlmmPositionSnapshot): Promise<void> {
  if (dlmmStore.hasSeen(snapshot.positionAddress)) return;
  // claim the slot synchronously to prevent double-notify
  dlmmStore.recordSeen(snapshot.positionAddress, {
    lbPair: snapshot.lbPairAddress,
    sol: snapshot.solValue,
  });

  const verdict = isDlmmBuyWall(snapshot, {
    minSol: config.dlmmBuywall.minSol,
    direction: config.dlmmBuywall.direction,
    singleSideThreshold: config.dlmmBuywall.singleSideThreshold,
  });
  if (!verdict.matched) {
    logger.debug("DLMM position not a buy wall", {
      position: snapshot.positionAddress.substring(0, 12),
      reason: verdict.reason,
    });
    return;
  }

  const wall: DetectedDlmmBuyWall = { ...snapshot, matchedReason: verdict.reason };
  logger.info("🚧 DLMM buy wall detected", {
    position: snapshot.positionAddress,
    sol: snapshot.solValue.toFixed(2),
    lbPair: snapshot.lbPairAddress,
  });
  await telegramBot.notifyAdmin(formatDlmmBuyWallMessage(wall));
}

/**
 * Handle a newly detected pool candidate.
 */
async function handleNewPool(candidate: PoolCandidate): Promise<void> {
  logger.info("Evaluating new pool", {
    pool: candidate.poolAddress,
    creator: candidate.creator,
    liquiditySol: candidate.initialLiquiditySol.toFixed(4),
  });

  // Apply filters
  const filterConfig: FilterConfig = {
    minPoolLiquiditySol: config.filter.minPoolLiquiditySol,
    creatorWhitelist: config.filter.creatorWhitelist,
    creatorBlacklist: config.filter.creatorBlacklist,
  };
  const filterResult = shouldTailPool(candidate, filterConfig);
  if (!filterResult.accepted) {
    logger.info("Pool rejected by filter", {
      pool: candidate.poolAddress,
      reason: filterResult.reason,
    });
    return;
  }

  // Risk check
  const positionSizeSol = config.position.sizeSol;
  const riskCheck = await checkCanOpenPosition(positionSizeSol);
  if (!riskCheck.allowed) {
    await telegramBot.notifyAdmin(
      `\ud83d\udeab <b>Position rejected</b>\n` +
        `Pool: <code>${candidate.poolAddress}</code>\n` +
        `Reason: ${riskCheck.reason}`
    );
    return;
  }

  // Fetch pool state
  const poolAddress = new PublicKey(candidate.poolAddress);
  const pool = await getPoolByAddress(poolAddress);
  if (!pool) {
    logger.error("Could not fetch pool for position opening", {
      pool: candidate.poolAddress,
    });
    return;
  }

  // Determine which side is SOL and which is the token to acquire
  const isSolA = pool.tokenAMint.equals(SOL_MINT);
  const tokenMint = isSolA ? pool.tokenBMint : pool.tokenAMint;

  try {
    await telegramBot.notifyAdmin(
      `\u23f3 <b>Tailing new pool...</b>\n` +
        `Pool: <code>${candidate.poolAddress}</code>\n` +
        `Creator: <code>${candidate.creator}</code>\n` +
        `Liquidity: ${candidate.initialLiquiditySol.toFixed(2)} SOL\n` +
        `Token: <code>${tokenMint.toBase58()}</code>\n` +
        `Size: ${positionSizeSol} SOL`
    );

    // Step 1: Swap half the SOL for the paired token via Jupiter
    const halfSol = positionSizeSol / 2;
    logger.info("Step 1: Swapping SOL for token", {
      solAmount: halfSol,
      tokenMint: tokenMint.toBase58(),
    });

    const swapResult = await swapSolForToken(
      tokenMint,
      halfSol,
      config.swap.slippageBps
    );
    if (!swapResult.success) {
      logger.error("Jupiter swap failed", { error: swapResult.error });
      await telegramBot.notifyAdmin(
        `\u274c <b>Swap failed</b>\n` +
          `Pool: <code>${candidate.poolAddress}</code>\n` +
          `Error: <code>${swapResult.error}</code>`
      );
      return;
    }

    logger.info("Swap successful", {
      txSig: swapResult.txSignature,
      outputAmount: swapResult.outputAmount,
    });

    // Step 2: Get actual token balance after swap
    const tokenBalance = await getTokenBalance(tokenMint);
    if (tokenBalance.amount <= 0) {
      logger.error("Token balance 0 after swap");
      await telegramBot.notifyAdmin(
        `\u274c <b>Token balance 0 after swap</b>\n` +
          `Pool: <code>${candidate.poolAddress}</code>`
      );
      return;
    }

    // Step 3: Open LP position with actual balances
    const solForLp = new BN(Math.floor(halfSol * LAMPORTS_PER_SOL));
    const tokenRaw = new BN(swapResult.outputAmount.toString());

    // Assign to correct sides (A or B) based on pool ordering
    const maxTokenA = isSolA ? solForLp : tokenRaw;
    const maxTokenB = isSolA ? tokenRaw : solForLp;

    logger.info("Step 2: Opening LP position", {
      maxTokenA: maxTokenA.toString(),
      maxTokenB: maxTokenB.toString(),
    });

    const result = await openPosition(pool, maxTokenA, maxTokenB);

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
      `\u2705 <b>Position opened!</b>\n` +
        `ID: <code>${tracked.id}</code>\n` +
        `Pool: <code>${candidate.poolAddress}</code>\n` +
        `Position: <code>${result.positionAddress.toBase58()}</code>\n` +
        `Swap: ${halfSol} SOL \u2192 ${tokenBalance.amount.toFixed(2)} tokens\n` +
        `LP: ${halfSol} SOL + tokens\n` +
        `TX: <code>${result.txSignature}</code>\n` +
        `SL: -${config.risk.stopLossPercent}% | TP: +${config.risk.takeProfitPercent}% | Max: ${config.risk.maxHoldMinutes}min`
    );
  } catch (err) {
    logger.error("Failed to open position", { error: String(err) });
    await telegramBot.notifyAdmin(
      `\u274c <b>Position failed</b>\n` +
        `Pool: <code>${candidate.poolAddress}</code>\n` +
        `Error: <code>${String(err)}</code>`
    );
  }
}

function startMonitor(): void {
  if (monitorInterval) return;

  monitorInterval = setInterval(async () => {
    try {
      const result = await monitorPositions();
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

function registerAdminCommands(): void {
  telegramBot.registerCommand("status", async (ctx) => {
    const balance = await getWalletBalance();
    const openPos = getOpenPositions();
    const totalPnl = getTotalPnl();
    const exposure = getTotalExposureSol();

    await ctx.reply(
      `\ud83d\udcca <b>Pool Tailer Status</b>\n\n` +
        `\ud83d\udcb0 Balance: ${balance.toFixed(4)} SOL\n` +
        `\ud83d\udcc8 Open Positions: ${openPos.length}/${config.position.maxOpenPositions}\n` +
        `\ud83d\udcb5 Exposure: ${exposure.toFixed(4)}/${config.position.maxTotalExposureSol} SOL\n` +
        `\ud83d\udcc9 Total P&L: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL\n` +
        `\u2699\ufe0f Position Size: ${config.position.sizeSol} SOL\n` +
        `\ud83d\udd0d Min Liquidity: ${config.filter.minPoolLiquiditySol} SOL\n` +
        `\ud83d\uded1 SL: -${config.risk.stopLossPercent}% | TP: +${config.risk.takeProfitPercent}% | Hold: ${config.risk.maxHoldMinutes}min`,
      { parse_mode: "HTML" }
    );
  });

  telegramBot.registerCommand("positions", async (ctx) => {
    const openPos = getOpenPositions();
    if (openPos.length === 0) {
      await ctx.reply("\ud83d\udced No open positions.");
      return;
    }

    let msg = `\ud83d\udccb <b>Open Positions (${openPos.length})</b>\n\n`;
    for (const pos of openPos) {
      const holdMin = (
        (Date.now() - new Date(pos.openedAt).getTime()) /
        60_000
      ).toFixed(0);
      msg +=
        `<b>${pos.id}</b>\n` +
        `  Pool: <code>${pos.poolAddress.substring(0, 12)}...</code>\n` +
        `  Size: ${pos.entryValueSol} SOL\n` +
        `  Hold: ${holdMin}min / ${config.risk.maxHoldMinutes}min\n\n`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  });

  telegramBot.registerCommand("balance", async (ctx) => {
    const wallet = getWallet();
    const balance = await getWalletBalance();
    await ctx.reply(
      `\ud83d\udcb0 <b>Wallet</b>\n` +
        `Address: <code>${wallet.publicKey.toBase58()}</code>\n` +
        `Balance: ${balance.toFixed(4)} SOL`,
      { parse_mode: "HTML" }
    );
  });

  telegramBot.registerCommand("closeall", async (ctx) => {
    const openPos = getOpenPositions();
    if (openPos.length === 0) {
      await ctx.reply("\ud83d\udced No open positions to close.");
      return;
    }
    await ctx.reply(`\u23f3 Closing ${openPos.length} position(s)...`);
    const results = await closeAllPositions();
    await ctx.reply(
      `\ud83d\udccb <b>Results:</b>\n` + results.join("\n"),
      { parse_mode: "HTML" }
    );
  });

  telegramBot.registerCommand("history", async (ctx) => {
    const allPos = getAllPositions().filter((p) => p.status === "closed");
    if (allPos.length === 0) {
      await ctx.reply("\ud83d\udced No closed positions.");
      return;
    }

    const last10 = allPos.slice(-10);
    let msg = `\ud83d\udccb <b>Last ${last10.length} closed positions</b>\n\n`;
    for (const pos of last10) {
      const pnl =
        pos.pnlSol !== undefined
          ? `${pos.pnlSol >= 0 ? "+" : ""}${pos.pnlSol.toFixed(4)} SOL`
          : "N/A";
      msg +=
        `<b>${pos.id}</b>\n` +
        `  Reason: ${pos.closeReason}\n` +
        `  P&L: ${pnl}\n` +
        `  Closed: ${pos.closedAt || "N/A"}\n\n`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  });
}

async function main(): Promise<void> {
  logger.info("=== Meteora DAMM v2 Pool Tailer ===");
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
  registerAdminCommands();
  await telegramBot.start();

  // Start pool listener (WebSocket)
  poolListener = new PoolListener();
  poolListener.onPoolDetected(handleNewPool);
  poolListener.start();

  if (config.dlmmBuywall.enabled) {
    dlmmListener = new DlmmPositionListener();
    dlmmListener.onPositionSnapshot(handleDlmmBuyWall);
    dlmmListener.start();
    logger.info("DLMM buy wall tracker enabled", {
      minSol: config.dlmmBuywall.minSol,
      direction: config.dlmmBuywall.direction,
    });
  } else {
    logger.info("DLMM buy wall tracker disabled (DLMM_BUYWALL_ENABLED=true)");
  }

  // Start position monitor
  startMonitor();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    poolListener.stop();
    if (dlmmListener) dlmmListener.stop();
    stopMonitor();
    await telegramBot.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("Pool Tailer running. Watching for new DAMM v2 pools...");
}

main().catch((err) => {
  logger.error("Fatal error", { error: String(err) });
  process.exit(1);
});
