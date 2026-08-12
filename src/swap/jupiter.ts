/**
 * jupiter.ts — Jupiter swap integration for acquiring tokens before LP entry.
 *
 * Flow: SOL → Token swap via Jupiter v6 API, then use the acquired tokens
 * together with remaining SOL to open an LP position.
 */

import {
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  sendAndConfirmTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { getConnection } from "../solana/connection";
import { getWallet } from "../solana/wallet";
import { logger } from "../utils/logger";

const JUPITER_QUOTE_URL = "https://public.jupiterapi.com/quote";
const JUPITER_SWAP_URL = "https://public.jupiterapi.com/swap";
const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface SwapResult {
  success: boolean;
  txSignature?: string;
  inputAmountLamports: number;
  outputAmount: number;
  outputDecimals: number;
  error?: string;
}

/**
 * Swap SOL for a token via Jupiter v6 API.
 *
 * @param outputMint - Token mint to buy
 * @param solAmount - Amount of SOL to spend (in SOL, not lamports)
 * @param slippageBps - Slippage tolerance in basis points (default 300 = 3%)
 */
export async function swapSolForToken(
  outputMint: PublicKey,
  solAmount: number,
  slippageBps: number = 300
): Promise<SwapResult> {
  const wallet = getWallet();
  const connection = getConnection();
  const inputAmountLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

  logger.info("Jupiter swap: SOL → Token", {
    outputMint: outputMint.toBase58(),
    solAmount,
    slippageBps,
  });

  try {
    // 1. Get quote
    const quoteParams = new URLSearchParams({
      inputMint: SOL_MINT,
      outputMint: outputMint.toBase58(),
      amount: inputAmountLamports.toString(),
      slippageBps: slippageBps.toString(),
    });

    const quoteResp = await fetch(`${JUPITER_QUOTE_URL}?${quoteParams}`);
    if (!quoteResp.ok) {
      const errText = await quoteResp.text();
      return {
        success: false,
        inputAmountLamports,
        outputAmount: 0,
        outputDecimals: 0,
        error: `Jupiter quote failed: ${quoteResp.status} ${errText.substring(0, 200)}`,
      };
    }

    const quoteData = (await quoteResp.json()) as Record<string, any>;
    const outAmount = parseInt(quoteData.outAmount || "0", 10);

    if (outAmount <= 0) {
      return {
        success: false,
        inputAmountLamports,
        outputAmount: 0,
        outputDecimals: 0,
        error: "Jupiter quote returned 0 output",
      };
    }

    logger.info("Jupiter quote received", {
      inAmount: quoteData.inAmount,
      outAmount: quoteData.outAmount,
      priceImpact: quoteData.priceImpactPct,
    });

    // 2. Get swap transaction
    const swapResp = await fetch(JUPITER_SWAP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
    });

    if (!swapResp.ok) {
      const errText = await swapResp.text();
      return {
        success: false,
        inputAmountLamports,
        outputAmount: 0,
        outputDecimals: 0,
        error: `Jupiter swap TX failed: ${swapResp.status} ${errText.substring(0, 200)}`,
      };
    }

    const swapData = (await swapResp.json()) as Record<string, any>;
    const swapTxBuf = Buffer.from(swapData.swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(swapTxBuf);

    // 3. Sign and send
    tx.sign([wallet]);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    // 4. Confirm
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      {
        signature: sig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed"
    );

    logger.info("Jupiter swap confirmed", {
      signature: sig,
      outAmount: quoteData.outAmount,
    });

    return {
      success: true,
      txSignature: sig,
      inputAmountLamports,
      outputAmount: outAmount,
      outputDecimals: parseInt(quoteData.outputDecimals || "6", 10),
    };
  } catch (err) {
    logger.error("Jupiter swap error", { error: String(err) });
    return {
      success: false,
      inputAmountLamports,
      outputAmount: 0,
      outputDecimals: 0,
      error: String(err),
    };
  }
}

/**
 * Get the token balance for a specific mint in the wallet.
 */
export async function getTokenBalance(
  mint: PublicKey
): Promise<{ amount: number; decimals: number }> {
  const connection = getConnection();
  const wallet = getWallet();

  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { mint }
    );

    if (tokenAccounts.value.length === 0) {
      return { amount: 0, decimals: 0 };
    }

    const info = tokenAccounts.value[0].account.data.parsed.info;
    return {
      amount: parseFloat(info.tokenAmount.uiAmountString || "0"),
      decimals: info.tokenAmount.decimals,
    };
  } catch (err) {
    logger.warn("Could not fetch token balance", {
      mint: mint.toBase58(),
      error: String(err),
    });
    return { amount: 0, decimals: 0 };
  }
}
