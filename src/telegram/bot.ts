import { config } from "../config";
import { logger } from "../utils/logger";

const TELEGRAM_API = `https://api.telegram.org/bot${config.telegram.botToken}`;

/**
 * Minimal context object compatible with the subset of Telegraf's Context used
 * by command handlers (ctx.reply, ctx.message, ctx.chat).
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
  private isRunning = false;
  private pollAbort: AbortController | null = null;
  private updateOffset = 0;
  private consecutive409s = 0;

  private commandHandlers: Array<{
    command: string;
    handler: (ctx: MinimalContext) => Promise<void>;
  }> = [];

  // ── Public API (unchanged signatures) ────────────────────────────

  /**
   * Send a message to the admin chat.
   */
  async notifyAdmin(message: string): Promise<void> {
    try {
      await this.apiCall("sendMessage", {
        chat_id: config.telegram.adminChatId,
        text: message,
        parse_mode: "HTML",
      });
    } catch (err) {
      logger.error("Failed to send admin notification", {
        error: String(err),
      });
    }
  }

  /**
   * Start the bot.  Uses plain fetch() long-polling against the Telegram
   * getUpdates API.  No Telegraf polling is involved, so there is no risk
   * of 409 "Conflict: terminated by other getUpdates request" errors from
   * competing Telegraf instances.
   *
   * Startup sequence:
   *  1. deleteWebhook (+ drop pending updates) to clear any webhook config.
   *  2. A single non-blocking getUpdates with offset=-1 to flush / cancel
   *     any lingering long-poll session from a previous process.
   *  3. Enter our own long-poll loop.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    // 1. Ensure no webhook is set and drop pending updates
    await this.apiCall("deleteWebhook", { drop_pending_updates: true });

    // 2. Flush any lingering getUpdates session by requesting offset -1.
    //    This returns at most the last update and cancels the old poll.
    try {
      const flush = await this.apiCall("getUpdates", {
        offset: -1,
        timeout: 0,
      });
      if (flush.ok && flush.result?.length) {
        this.updateOffset =
          flush.result[flush.result.length - 1].update_id + 1;
      }
    } catch {
      // Ignore – the important thing is the old session is interrupted
    }

    // Wait briefly to let Telegram fully release the old polling session
    await new Promise((r) => setTimeout(r, 2_000));

    this.isRunning = true;
    this.pollAbort = new AbortController();

    // Fire-and-forget the polling loop (it runs until stop() is called)
    this.pollLoop().catch((err) => {
      if (this.isRunning) {
        logger.error("Polling loop crashed", { error: String(err) });
      }
    });

    logger.info("Telegram bot started (manual long-polling, no Telegraf)");

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
   * `.message`, and `.chat`.
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
          {
            offset: this.updateOffset,
            timeout: 30,
            allowed_updates: ["message"],
          },
          this.pollAbort?.signal
        );

        if (!data.ok || !Array.isArray(data.result)) continue;

        this.consecutive409s = 0; // Reset on successful poll

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

        // 409 = another getUpdates session is active; use exponential backoff
        const is409 =
          typeof err?.message === "string" && err.message.includes("409");

        if (is409) {
          this.consecutive409s = (this.consecutive409s || 0) + 1;
          // Exponential backoff: 10s, 20s, 40s, ... capped at 120s
          const backoff = Math.min(10_000 * Math.pow(2, this.consecutive409s - 1), 120_000);

          logger.warn(
            `Telegram 409 conflict (attempt ${this.consecutive409s}), waiting ${backoff / 1000}s before retry`,
          );

          await new Promise((r) => setTimeout(r, backoff));
        } else {
          this.consecutive409s = 0;
          logger.error(
            `Telegram getUpdates error, retrying in 5s`,
            { error: String(err) }
          );
          await new Promise((r) => setTimeout(r, 5_000));
        }
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

    // Built-in handlers
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
      throw new Error(
        `Telegram API ${method} failed (${resp.status}): ${body}`
      );
    }

    return resp.json();
  }
}
