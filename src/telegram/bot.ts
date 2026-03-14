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
   * Start the bot.
   * Clears any stale Telegram polling connection before launching
   * to prevent 409 "Conflict" errors.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    // Drop pending updates and clear any stale getUpdates connection
    await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });

    await this.bot.launch();
    this.isRunning = true;
    logger.info("Telegram bot started");

    await this.notifyAdmin(
      "🟢 <b>Bot gestartet</b>\nMeteora DAMM v2 Pool-Watcher ist online."
    );
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
