import { Telegraf, Context } from "telegraf";
import { config } from "../config";
import { logger } from "../utils/logger";

export class TelegramBot {
  private bot: Telegraf;
  private isRunning = false;

  constructor() {
    this.bot = new Telegraf(config.telegram.botToken);
    this.bot.catch((err: any) => {
      logger.error("Telegram bot error", { error: String(err) });
    });
  }

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

  async start(): Promise<void> {
    if (this.isRunning) return;
    await this.bot.launch();
    this.isRunning = true;
    logger.info("Telegram bot started");
    await this.notifyAdmin(
      "\ud83d\udfe2 <b>Pool Tailer gestartet</b>\nWatching for new DAMM v2 pools..."
    );
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    await this.notifyAdmin(
      "\ud83d\udd34 <b>Pool Tailer gestoppt</b>"
    );
    this.bot.stop("SIGTERM");
    this.isRunning = false;
    logger.info("Telegram bot stopped");
  }

  registerCommand(
    command: string,
    handler: (ctx: Context) => Promise<void>
  ): void {
    this.bot.command(command, async (ctx) => {
      if (ctx.chat?.id?.toString() !== config.telegram.adminChatId) return;
      await handler(ctx);
    });
  }
}
