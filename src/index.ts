import { config } from "./config";
import { logger } from "./utils/logger";
import { TelegramBot } from "./telegram/bot";
import { DlmmPositionListener } from "./listener/dlmm-position-listener";
import { isDlmmBuyWall } from "./dlmm-buywall/filter";
import { createDlmmBuyWallStore } from "./dlmm-buywall/store";
import { formatDlmmBuyWallMessage } from "./dlmm-buywall/notifier";
import { enrichWall } from "./dlmm-buywall/enrich";
import { computeWallMetrics, computeSignalScore, classifyRelativeTier } from "./dlmm-buywall/metrics";
import { DlmmPositionSnapshot } from "./dlmm-buywall/types";
import { DashboardServer, ActivityEntry } from "./dashboard/server";
import * as path from "path";

let telegramBot: TelegramBot;
let dlmmListener: DlmmPositionListener | null = null;
let dashboardServer: DashboardServer | null = null;
const dlmmStore = createDlmmBuyWallStore(
  path.join(process.cwd(), "data", "dlmm-buywalls.json")
);

const ACTIVITY_BUFFER_SIZE = 50;
const recentActivity: ActivityEntry[] = [];

function pushActivity(entry: ActivityEntry): void {
  recentActivity.unshift(entry);
  if (recentActivity.length > ACTIVITY_BUFFER_SIZE) recentActivity.pop();
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

  const wall = { ...snapshot, matchedReason: verdict.reason };
  const enriched = await enrichWall(wall);

  const metrics = computeWallMetrics(enriched);
  const relTier = classifyRelativeTier(
    enriched.solValue,
    enriched.volume24hUsd ?? 0,
    enriched.solPriceUsd ?? 0
  );
  enriched.signalScore = computeSignalScore({
    solValue: enriched.solValue,
    distancePct: metrics.distancePct,
    solPerBin: enriched.solPerBin,
    solFraction: enriched.solFraction,
    wallToVolumePct: relTier.wallToVolumePct || undefined,
  });

  dlmmStore.recordWall(enriched);

  logger.info("DLMM buy wall detected", {
    position: snapshot.positionAddress,
    sol: snapshot.solValue.toFixed(2),
    score: enriched.signalScore,
    token: enriched.tokenSymbol ?? "unknown",
    lbPair: snapshot.lbPairAddress,
  });
  await telegramBot.notifyAdmin(formatDlmmBuyWallMessage(enriched));
}

function registerAdminCommands(): void {
  telegramBot.registerCommand("status", async (ctx) => {
    const listenerStatus = dlmmListener?.getStatus();
    const wallCount = dlmmStore.size();
    await ctx.reply(
      `📊 <b>Buy Wall Tracker Status</b>\n\n` +
        `🧱 Walls erkannt: ${wallCount}\n` +
        `📡 WebSocket: ${listenerStatus?.active ? "✅ verbunden" : "❌ getrennt"}\n` +
        `⏱ Letztes Event: ${listenerStatus ? `vor ${listenerStatus.lastEventAgeSec}s` : "–"}\n` +
        `🔄 Reconnects: ${listenerStatus?.reconnectAttempts ?? 0}\n\n` +
        `⚙️ <b>Config</b>\n` +
        `Min SOL: ${config.dlmmBuywall.minSol}\n` +
        `Richtung: ${config.dlmmBuywall.direction}\n` +
        `Einseitig-Schwelle: ${(config.dlmmBuywall.singleSideThreshold * 100).toFixed(0)}%\n` +
        (config.dashboard.enabled
          ? `\n📊 Dashboard: Port ${config.dashboard.port} (http://SERVER_IP:${config.dashboard.port})`
          : ""),
      { parse_mode: "HTML" }
    );
  });

  telegramBot.registerCommand("walls", async (ctx) => {
    const walls = dlmmStore.getWalls().slice(0, 5);
    if (walls.length === 0) {
      await ctx.reply("📭 Noch keine Buy Walls erkannt.");
      return;
    }
    let msg = `🧱 <b>Letzte ${walls.length} Buy Walls</b>\n\n`;
    for (const w of walls) {
      const score = w.signalScore ?? 0;
      msg +=
        `${score >= 80 ? "🔥" : score >= 60 ? "📈" : "📊"} ` +
        `<b>${w.tokenSymbol ?? "?"}</b> — ${w.solValue.toFixed(1)} SOL (Score ${score})\n` +
        `  Pool: <code>${w.lbPairAddress.substring(0, 12)}…</code>\n\n`;
    }
    await ctx.reply(msg, { parse_mode: "HTML" });
  });
}

async function main(): Promise<void> {
  logger.info("=== DLMM Buy Wall Tracker ===");
  logger.info("Starting up...");

  telegramBot = new TelegramBot();
  registerAdminCommands();
  await telegramBot.start();

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

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    dlmmListener?.stop();
    dashboardServer?.stop();
    await telegramBot.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("Bot is running. Waiting for buy walls...");
}

async function gracefulExit(reason: string, err?: unknown): Promise<void> {
  logger.error(`${reason}`, { error: err ? String(err) : "unknown" });
  try {
    dlmmListener?.stop();
    dashboardServer?.stop();
    if (telegramBot) await telegramBot.stop();
  } catch (cleanupErr) {
    logger.error("Error during cleanup", { error: String(cleanupErr) });
  }
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
