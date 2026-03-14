import { Telegraf, Context } from "telegraf";
import { config } from "../config";
import { logger } from "../utils/logger";

export class TelegramBot {
  private bot: Telegraf;
  private isRunning = false;

  constructor() {
    this.bot = new Telegraf(config.telegram.botToken);
    this.setupHandlers();
  }

  /**
   * Send a message to the admin chat.
   */
  async notifyAdmin(message: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(
        config.telegram.adminChatId,
        message,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      logger.error("Failed to send admin notification", {
        error: String(err),
      });
    }
  }

  /**
   * Start the bot with retry logic for 409 "Conflict" errors.
   * Telegram keeps long-polling connections alive for ~30s after a process dies.
   * If we get a 409, we wait and retry instead of crashing.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    const maxRetries = 5;
    const retryDelaySec = 10;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Force-clear any stale polling session
        await this.bot.telegram.callApi("getUpdates", {
          offset: -1,
          timeout: 0,
        });

        await this.bot.launch({ dropPendingUpdates: true });
        this.isRunning = true;
        logger.info("Telegram bot started");

        await this.notifyAdmin(
          "🟢 <b>Bot gestartet</b>\nMeteora DAMM v2 Pool-Watcher ist online."
        );
        return;
      } catch (err) {
        const is409 = String(err).includes("409");
        if (is409 && attempt < maxRetries) {
          logger.warn(
            `Telegram 409 conflict on attempt ${attempt}/${maxRetries}, ` +
            `retrying in ${retryDelaySec}s...`
          );
          await new Promise((r) => setTimeout(r, retryDelaySec * 1000));
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Stop the bot gracefully.
   * Always attempts to stop Telegraf polling, even if isRunning is false,
   * to ensure the getUpdates connection is released.
   */
  async stop(): Promise<void> {
    if (this.isRunning) {
      await this.notifyAdmin(
        "🔴 <b>Bot gestoppt</b>\nMeteora DAMM v2 Pool-Watcher wird heruntergefahren."
      );
    }

    try {
      this.bot.stop("SIGTERM");
    } catch {
      // Ignore errors during stop — bot may not have been launched
    }
    this.isRunning = false;
    logger.info("Telegram bot stopped");
  }

  private setupHandlers(): void {
    // Handle admin messages
    this.bot.on("message", async (ctx: Context) => {
      try {
        const chatId = ctx.chat?.id?.toString();
        if (chatId !== config.telegram.adminChatId) return;

        await this.handleAdminMessage(ctx);
      } catch (err) {
        logger.error("Error processing message", { error: String(err) });
      }
    });

    this.bot.catch((err: any) => {
      logger.error("Telegram bot error", { error: String(err) });
    });
  }

  private async handleAdminMessage(ctx: Context): Promise<void> {
    const text = this.extractText(ctx);
    if (!text) return;

    const command = text.trim().toLowerCase();

    if (command === "/status") {
      await ctx.reply("🟢 Bot ist aktiv. Pool-Watcher läuft.");
    } else if (command === "/help") {
      await ctx.reply(
        "📋 <b>Verfügbare Befehle:</b>\n\n" +
          "/status - Bot-Status anzeigen\n" +
          "/positions - Offene Positionen anzeigen\n" +
          "/balance - Wallet-Balance anzeigen\n" +
          "/mcap &lt;token&gt; - Market Cap abfragen\n" +
          "/closeall - Alle Positionen schließen\n" +
          "/history - Geschlossene Positionen\n" +
          "/help - Diese Hilfe anzeigen",
        { parse_mode: "HTML" }
      );
    }
  }

  /**
   * Register additional command handlers.
   */
  registerCommand(
    command: string,
    handler: (ctx: Context) => Promise<void>
  ): void {
    this.bot.command(command, async (ctx) => {
      if (ctx.chat?.id?.toString() !== config.telegram.adminChatId) return;
      await handler(ctx);
    });
  }

  private extractText(ctx: Context): string | null {
    const msg = ctx.message;
    if (!msg) return null;

    if ("text" in msg) return msg.text;
    if ("caption" in msg) return msg.caption || null;
    return null;
  }
}
