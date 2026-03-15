import { PublicKey, ConfirmedSignatureInfo } from "@solana/web3.js";
import bs58 from "bs58";
import { getConnection } from "../solana/connection";
import { logger } from "../utils/logger";
import { config } from "../config";

/**
 * DAMM v2 Program ID
 */
const DAMM_V2_PROGRAM = new PublicKey(
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
);

/**
 * Anchor instruction discriminator for initializePool (first 8 bytes).
 * From Solscan: 5fb40aac54aee828
 */
const INITIALIZE_POOL_DISCRIMINATOR = "5fb40aac54aee828";

/**
 * SOL mint (WSOL) - used to identify the non-SOL token in pools.
 */
const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface NewPoolEvent {
  poolAddress: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  txSignature: string;
  timestamp: number;
}

export type PoolCallback = (event: NewPoolEvent) => Promise<void>;

/**
 * Watches for new DAMM v2 pool creations by polling recent transactions.
 * Uses getSignaturesForAddress to find new initializePool transactions.
 */
export class PoolWatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastSignature: string | null = null;
  private callback: PoolCallback | null = null;
  private running = false;

  /**
   * Register a callback for new pool events.
   */
  onNewPool(callback: PoolCallback): void {
    this.callback = callback;
  }

  /**
   * Start watching for new pools.
   */
  start(): void {
    if (this.interval) return;

    const pollIntervalMs = config.watcher.pollIntervalSeconds * 1000;

    // Initial poll to set the baseline (don't process old pools)
    this.initBaseline().then(() => {
      this.interval = setInterval(() => {
        if (this.running) return;
        this.poll().catch((err) => {
          logger.error("Pool watcher poll error", { error: String(err) });
        });
      }, pollIntervalMs);

      logger.info("Pool watcher started", {
        programId: DAMM_V2_PROGRAM.toBase58(),
        pollIntervalSeconds: config.watcher.pollIntervalSeconds,
      });
    });
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info("Pool watcher stopped");
    }
  }

  /**
   * Set the baseline: remember the latest signature so we only process new TXs.
   */
  private async initBaseline(): Promise<void> {
    try {
      const connection = getConnection();
      const sigs = await connection.getSignaturesForAddress(
        DAMM_V2_PROGRAM,
        { limit: 1 },
        "confirmed"
      );
      if (sigs.length > 0) {
        this.lastSignature = sigs[0].signature;
        logger.info("Pool watcher baseline set", {
          lastSignature: this.lastSignature,
        });
      }
    } catch (err) {
      logger.error("Failed to set pool watcher baseline", {
        error: String(err),
      });
    }
  }

  /**
   * Poll for new transactions since the last known signature.
   */
  private async poll(): Promise<void> {
    this.running = true;
    try {
      const connection = getConnection();

      // Fetch recent signatures for the DAMM v2 program
      const options: any = { limit: 20 };
      if (this.lastSignature) {
        options.until = this.lastSignature;
      }

      const sigs = await connection.getSignaturesForAddress(
        DAMM_V2_PROGRAM,
        options,
        "confirmed"
      );

      if (sigs.length === 0) return;

      // Update last signature to the newest one
      this.lastSignature = sigs[0].signature;

      // Process from oldest to newest
      const newSigs = sigs.reverse();

      for (const sig of newSigs) {
        if (sig.err) continue; // Skip failed TXs

        try {
          const event = await this.parseTransaction(sig.signature);
          if (event && this.callback) {
            await this.callback(event);
          }
        } catch (err) {
          logger.debug("Failed to parse TX", {
            signature: sig.signature,
            error: String(err),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Parse a transaction to check if it's an initializePool and extract pool address.
   */
  private async parseTransaction(
    signature: string
  ): Promise<NewPoolEvent | null> {
    const connection = getConnection();
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    if (!tx || !tx.meta || tx.meta.err) return null;

    const message = tx.transaction.message;

    // Find the DAMM v2 program instruction
    for (const ix of message.instructions) {
      if ("programId" in ix && ix.programId.equals(DAMM_V2_PROGRAM)) {
        // Check if it's a compiled instruction with data
        if ("data" in ix && typeof ix.data === "string") {
          // The data is base58 encoded; decode the first 8 bytes to check discriminator
          const dataBytes = Buffer.from(bs58.decode(ix.data));
          const discriminator = dataBytes.subarray(0, 8).toString("hex");

          if (discriminator === INITIALIZE_POOL_DISCRIMINATOR) {
            return this.extractPoolFromTx(tx, signature);
          }
        }
      }
    }

    // Also check inner instructions
    if (tx.meta.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          if ("programId" in ix && ix.programId.equals(DAMM_V2_PROGRAM)) {
            if ("data" in ix && typeof ix.data === "string") {
              const dataBytes = Buffer.from(bs58.decode(ix.data));
              const discriminator = dataBytes.subarray(0, 8).toString("hex");

              if (discriminator === INITIALIZE_POOL_DISCRIMINATOR) {
                return this.extractPoolFromTx(tx, signature);
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Extract pool address and token mints from a confirmed initializePool TX.
   * The pool account is typically the first writable account created by the program.
   * We look for new accounts in postBalances that didn't exist in preBalances.
   */
  private extractPoolFromTx(
    tx: any,
    signature: string
  ): NewPoolEvent | null {
    try {
      const accountKeys = tx.transaction.message.accountKeys;
      const preBalances = tx.meta.preBalances;
      const postBalances = tx.meta.postBalances;

      // Find accounts owned by DAMM v2 program in post-transaction state
      // The pool account is a new account created during the TX
      let poolAddress: PublicKey | null = null;
      let tokenAMint: PublicKey | null = null;
      let tokenBMint: PublicKey | null = null;

      // Strategy: look at postTokenBalances for the token mints in the pool
      // The pool address is typically the account that receives SOL for rent
      // and is owned by the DAMM v2 program
      const postTokenBalances = tx.meta.postTokenBalances || [];

      // Collect unique token mints from the TX (excluding system tokens)
      const tokenMints = new Set<string>();
      for (const tb of postTokenBalances) {
        if (tb.mint && tb.mint !== WSOL_MINT) {
          tokenMints.add(tb.mint);
        }
      }

      // Find newly created accounts (pre-balance 0, post-balance > 0)
      // that are likely the pool account
      for (let i = 0; i < accountKeys.length; i++) {
        const key = accountKeys[i];
        const pubkey =
          typeof key === "string"
            ? key
            : key.pubkey
              ? key.pubkey.toBase58()
              : String(key);

        if (preBalances[i] === 0 && postBalances[i] > 0) {
          // This is a newly created account
          // Check if it's not a token account (token accounts are smaller)
          const rentLamports = postBalances[i];
          // Pool accounts are typically larger (>3000 lamports rent)
          // Token accounts are ~2039280 lamports
          // Pool state accounts have more rent due to larger size
          if (rentLamports > 3_000_000 && !poolAddress) {
            poolAddress = new PublicKey(pubkey);
          }
        }
      }

      // Extract token mints from the instruction accounts
      // For initializePool, token mints are typically passed as accounts
      if (tokenMints.size > 0) {
        const mints = Array.from(tokenMints);
        tokenAMint = new PublicKey(mints[0]);
        if (mints.length > 1) {
          tokenBMint = new PublicKey(mints[1]);
        }
      }

      // Also check for WSOL if only one non-SOL token found
      if (tokenAMint && !tokenBMint) {
        // Check if WSOL is involved
        const hasWsol = postTokenBalances.some(
          (tb: any) => tb.mint === WSOL_MINT
        );
        if (hasWsol) {
          tokenBMint = new PublicKey(WSOL_MINT);
        }
      }

      if (!poolAddress) {
        logger.debug("Could not extract pool address from initializePool TX", {
          signature,
        });
        return null;
      }

      logger.info("New DAMM v2 pool detected!", {
        pool: poolAddress.toBase58(),
        tokenA: tokenAMint?.toBase58(),
        tokenB: tokenBMint?.toBase58(),
        tx: signature,
      });

      return {
        poolAddress,
        tokenAMint: tokenAMint || PublicKey.default,
        tokenBMint: tokenBMint || PublicKey.default,
        txSignature: signature,
        timestamp: tx.blockTime || Math.floor(Date.now() / 1000),
      };
    } catch (err) {
      logger.error("Failed to extract pool from TX", {
        signature,
        error: String(err),
      });
      return null;
    }
  }
}
