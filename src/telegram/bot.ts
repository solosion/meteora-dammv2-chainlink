import { Telegraf } from "telegraf";
import { config } from "../config";
import { logger } from "../utils/logger";

const TELEGRAM_API = `https://api.telegram.org/bot${config.telegram.botToken}`;

/**
 * Minimal context object that is compatible with the subset of Telegraf's
 * Context used by the command handlers in this project (ctx.reply, ctx.message,
 * ctx.chat).  This lets callers keep the same handler signatures without
 * pulling in Telegraf's polling machinery.
 */
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  date: number;
  from?: { id: number; is_bot: boolean; first_name: string };
}

interface MinimalContext {
  message: TgMessage | undefined;
  chat: { id: number; type: string } | undefined;
  reply: (text: string, extra?: { parse_mode?: string }) => Promise<void>;
}

export class TelegramBot {
  /**
   * Telegraf instance kept ONLY for its `telegram.sendMessage` helper.
   * We never call `bot.launch()`.
   */
  private bot: Telegraf;
  private isRunning = false;
  private pollAbort: AbortController | null = null;
  private updateOffset = 0;

  private commandHandlers: Array<{
    command: string;
    handler: (ctx: MinimalContext) => Promise<void>;
  }> = [];

  constructor() {
    this.bot = new Telegraf(config.telegram.botToken);
  }

  // ── Public API (unchanged signatures) ────────────────────────────

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
   * Start the bot.  Instead of Telegraf's `bot.launch()` (which opens its
   * own getUpdates loop and causes 409 conflicts when multiple instances
   * exist), we first clear any stuck Telegram session with a deleteWebhook
   * + a throwaway getUpdates call, then run our own long-polling loop
   * using plain `fetch()`.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    // 1. Ensure no webhook is set and drop pending updates
    await this.apiCall("deleteWebhook", { drop_pending_updates: true });

    // 2. Flush any lingering getUpdates session by requesting offset -1
    //    This returns at most the last update and clears the old poll.
    try {
      const flush = await this.apiCall("getUpdates", {
        offset: -1,
        timeout: 0,
      });
      if (flush.ok && flush.result?.length) {
        this.updateOffset = flush.result[flush.result.length - 1].update_id + 1;
      }
    } catch {
      // Ignore – the important thing is the old session is interrupted
    }

    this.isRunning = true;
    this.pollAbort = new AbortController();

    // Fire-and-forget the polling loop (it runs until stop() is called)
    this.pollLoop().catch((err) => {
      if (this.isRunning) {
        logger.error("Polling loop crashed", { error: String(err) });
      }
    });

    logger.info("Telegram bot started (manual long-polling)");

    await this.notifyAdmin(
      "🟢 <b>Bot gestartet</b>\nMeteora DAMM v2 Pool-Watcher ist online."
    );
  }

  /**
   * Stop the bot gracefully.
   */
  async stop(): Promise<void> {
    if (this.isRunning) {
      await this.notifyAdmin(
        "🔴 <b>Bot gestoppt</b>\nMeteora DAMM v2 Pool-Watcher wird heruntergefahren."
      );
    }

    this.isRunning = false;
    this.pollAbort?.abort();
    this.pollAbort = null;
    logger.info("Telegram bot stopped");
  }

  /**
   * Register an additional command handler.
   * The handler receives a minimal context object with `.reply()`,
   * `.message`, and `.chat` – the same subset used by the existing
   * command handlers in index.ts.
   */
  registerCommand(
    command: string,
    handler: (ctx: MinimalContext) => Promise<void>
  ): void {
    this.commandHandlers.push({ command, handler });
  }

  // ── Private: long-polling loop ───────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const data = await this.apiCall(
          "getUpdates",
          { offset: this.updateOffset, timeout: 30, allowed_updates: ["message"] },
          this.pollAbort?.signal
        );

        if (!data.ok || !Array.isArray(data.result)) continue;

        for (const update of data.result as TgUpdate[]) {
          this.updateOffset = update.update_id + 1;
          try {
            await this.handleUpdate(update);
          } catch (err) {
            logger.error("Error handling update", { error: String(err) });
          }
        }
      } catch (err: any) {
        // AbortError is expected when stop() is called
        if (err?.name === "AbortError") break;

        logger.error("Telegram getUpdates error, retrying in 5s", {
          error: String(err),
        });
        // Back off before retrying
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  /**
   * Process a single Telegram update.
   */
  private async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg) return;

    const chatId = msg.chat.id.toString();
    if (chatId !== config.telegram.adminChatId) return;

    const text = msg.text ?? msg.caption ?? null;
    if (!text) return;

    const ctx = this.buildContext(msg);

    // Check registered command handlers first
    const trimmed = text.trim();
    const cmdMatch = trimmed.match(/^\/(\S+)/);
    if (cmdMatch) {
      const cmdName = cmdMatch[1].toLowerCase().replace(/@.*$/, ""); // strip @botname

      for (const { command, handler } of this.commandHandlers) {
        if (command === cmdName) {
          await handler(ctx);
          return;
        }
      }
    }

    // Built-in handlers (same as old setupHandlers / handleAdminMessage)
    await this.handleBuiltinCommands(ctx, text);
  }

  private async handleBuiltinCommands(
    ctx: MinimalContext,
    text: string
  ): Promise<void> {
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

  // ── Helpers ──────────────────────────────────────────────────────

  /**
   * Build a minimal Telegraf-compatible context from a raw Telegram message.
   */
  private buildContext(msg: TgMessage): MinimalContext {
    return {
      message: msg,
      chat: msg.chat ? { id: msg.chat.id, type: msg.chat.type } : undefined,
      reply: async (text: string, extra?: { parse_mode?: string }) => {
        await this.apiCall("sendMessage", {
          chat_id: msg.chat.id,
          text,
          ...(extra?.parse_mode ? { parse_mode: extra.parse_mode } : {}),
        });
      },
    };
  }

  /**
   * Low-level Telegram Bot API call via fetch().
   */
  private async apiCall(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<any> {
    const resp = await fetch(`${TELEGRAM_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Telegram API ${method} failed (${resp.status}): ${body}`);
    }

    return resp.json();
  }
}
