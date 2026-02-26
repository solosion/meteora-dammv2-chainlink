import { Telegraf, Context } from "telegraf";
import { config } from "../config";
import { logger } from "../utils/logger";
import { parseAlertMessage, ParsedAlert } from "./parser";

export type AlertHandler = (alert: ParsedAlert) => Promise<void>;

export class TelegramBot {
  private bot: Telegraf;
  private alertHandlers: AlertHandler[] = [];
  private isRunning = false;

  constructor() {
    this.bot = new Telegraf(config.telegram.botToken);
    this.setupHandlers();
  }

  /**
   * Register a handler that will be called when a valid alert is detected.
   */
  onAlert(handler: AlertHandler): void {
    this.alertHandlers.push(handler);
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
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    await this.bot.launch();
    this.isRunning = true;
    logger.info("Telegram bot started");

    await this.notifyAdmin(
      "🟢 <b>Bot gestartet</b>\nMeteora DAMM v2 Alert Bot ist online und wartet auf Alerts."
    );
  }

  /**
   * Stop the bot gracefully.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    await this.notifyAdmin(
      "🔴 <b>Bot gestoppt</b>\nMeteora DAMM v2 Alert Bot wird heruntergefahren."
    );

    this.bot.stop("SIGTERM");
    this.isRunning = false;
    logger.info("Telegram bot stopped");
  }

  private setupHandlers(): void {
    // Listen to all messages from the alert channel
    this.bot.on("message", async (ctx: Context) => {
      try {
        const chatId = ctx.chat?.id?.toString();
        const senderId = ctx.from?.id?.toString() || "unknown";

        // Only process messages from the alert channel
        if (chatId !== config.telegram.alertChatId) {
          // Handle admin commands from admin chat
          if (chatId === config.telegram.adminChatId) {
            await this.handleAdminMessage(ctx);
          }
          return;
        }

        // Extract text from message
        const text = this.extractText(ctx);
        if (!text) return;

        logger.debug("Received alert channel message", {
          chatId,
          senderId,
          text: text.substring(0, 100),
        });

        // Parse the alert
        const alert = parseAlertMessage(text, senderId);
        if (!alert) return;

        // Notify admin about incoming alert
        await this.notifyAdmin(
          `📨 <b>Alert empfangen</b>\n` +
            `Token(s): ${alert.tokenMints.map((t) => `<code>${t.toBase58()}</code>`).join(", ")}\n` +
            (alert.poolAddress
              ? `Pool: <code>${alert.poolAddress.toBase58()}</code>\n`
              : "") +
            `Von: ${senderId}`
        );

        // Call all registered alert handlers
        for (const handler of this.alertHandlers) {
          try {
            await handler(alert);
          } catch (err) {
            logger.error("Alert handler failed", { error: String(err) });
            await this.notifyAdmin(
              `⚠️ <b>Alert Handler Fehler</b>\n<code>${String(err)}</code>`
            );
          }
        }
      } catch (err) {
        logger.error("Error processing message", { error: String(err) });
      }
    });

    // Error handling
    this.bot.catch((err: any) => {
      logger.error("Telegram bot error", { error: String(err) });
    });
  }

  private async handleAdminMessage(ctx: Context): Promise<void> {
    const text = this.extractText(ctx);
    if (!text) return;

    const command = text.trim().toLowerCase();

    if (command === "/status") {
      await ctx.reply("🟢 Bot ist aktiv und wartet auf Alerts.");
    } else if (command === "/help") {
      await ctx.reply(
        "📋 <b>Verfügbare Befehle:</b>\n\n" +
          "/status - Bot-Status anzeigen\n" +
          "/positions - Offene Positionen anzeigen\n" +
          "/balance - Wallet-Balance anzeigen\n" +
          "/feeds - Price Feed Status (Binance + Polymarket)\n" +
          "/closeall - Alle Positionen schließen\n" +
          "/history - Geschlossene Positionen anzeigen\n" +
          "/help - Diese Hilfe anzeigen",
        { parse_mode: "HTML" }
      );
    }
    // Other commands are handled by the main orchestrator via command registration
  }

  /**
   * Register additional command handlers.
   */
  registerCommand(
    command: string,
    handler: (ctx: Context) => Promise<void>
  ): void {
    this.bot.command(command, async (ctx) => {
      // Only allow admin
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
