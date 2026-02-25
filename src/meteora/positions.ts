import {
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { getCpAmm } from "./client";
import { PoolInfo } from "./pools";
import { getWallet } from "../solana/wallet";
import { getConnection } from "../solana/connection";
import { logger } from "../utils/logger";

// Token2022 program ID for NFT accounts
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

export interface OpenPositionResult {
  positionAddress: PublicKey;
  positionNftMint: PublicKey;
  txSignature: string;
  tokenAAmount: BN;
  tokenBAmount: BN;
}

/**
 * Opens a new liquidity position in a DAMM v2 pool using the combined
 * createPositionAndAddLiquidity method (single transaction).
 *
 * @param pool - Pool info
 * @param maxTokenA - Maximum amount of token A to deposit
 * @param maxTokenB - Maximum amount of token B to deposit
 * @param slippageBps - Slippage tolerance in basis points (e.g. 100 = 1%)
 */
export async function openPosition(
  pool: PoolInfo,
  maxTokenA: BN,
  maxTokenB: BN,
  slippageBps: number = 100
): Promise<OpenPositionResult> {
  const cpAmm = getCpAmm();
  const wallet = getWallet();
  const connection = getConnection();

  // Generate a new keypair for the position NFT mint
  const positionNftMint = Keypair.generate();

  logger.info("Creating position and adding liquidity...", {
    pool: pool.address.toBase58(),
    maxTokenA: maxTokenA.toString(),
    maxTokenB: maxTokenB.toString(),
  });

  // Calculate liquidity delta from desired token amounts
  const liquidityDelta = cpAmm.getLiquidityDelta({
    maxAmountTokenA: maxTokenA,
    maxAmountTokenB: maxTokenB,
    sqrtPrice: pool.sqrtPrice,
    sqrtMinPrice: pool.sqrtMinPrice,
    sqrtMaxPrice: pool.sqrtMaxPrice,
  });

  // Apply slippage tolerance for thresholds (allow depositing slightly more)
  const slippageMultiplier = 10000 + slippageBps;
  const tokenAMax = maxTokenA
    .mul(new BN(slippageMultiplier))
    .div(new BN(10000));
  const tokenBMax = maxTokenB
    .mul(new BN(slippageMultiplier))
    .div(new BN(10000));

  // Use the combined createPositionAndAddLiquidity method
  const tx = await cpAmm.createPositionAndAddLiquidity({
    owner: wallet.publicKey,
    pool: pool.address,
    positionNft: positionNftMint.publicKey,
    liquidityDelta,
    maxAmountTokenA: tokenAMax,
    maxAmountTokenB: tokenBMax,
    tokenAAmountThreshold: new BN(0),
    tokenBAmountThreshold: new BN(0),
    tokenAMint: pool.tokenAMint,
    tokenBMint: pool.tokenBMint,
    tokenAProgram: pool.tokenAProgram,
    tokenBProgram: pool.tokenBProgram,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  const sig = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet, positionNftMint],
    { commitment: "confirmed" }
  );

  logger.info("Position created and liquidity added", { signature: sig });

  // Find the position PDA from our created NFT
  const positions = await cpAmm.getPositionsByUser(wallet.publicKey);
  const newPos = positions.find((p) =>
    p.positionState.nftMint.equals(positionNftMint.publicKey)
  );

  const positionAddress = newPos
    ? newPos.position
    : PublicKey.default; // Fallback — should not happen

  return {
    positionAddress,
    positionNftMint: positionNftMint.publicKey,
    txSignature: sig,
    tokenAAmount: maxTokenA,
    tokenBAmount: maxTokenB,
  };
}

/**
 * Closes a position by removing all liquidity and closing it.
 */
export async function closePosition(
  pool: PoolInfo,
  positionAddress: PublicKey,
  positionNftMint: PublicKey
): Promise<string> {
  const cpAmm = getCpAmm();
  const wallet = getWallet();
  const connection = getConnection();

  logger.info("Closing position...", {
    position: positionAddress.toBase58(),
    pool: pool.address.toBase58(),
  });

  // Get the NFT token account (ATA for the position NFT under Token2022)
  const positionNftAccount = getAssociatedTokenAddressSync(
    positionNftMint,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  // Claim any pending fees first
  try {
    const claimTx = await cpAmm.claimPositionFee({
      owner: wallet.publicKey,
      pool: pool.address,
      position: positionAddress,
      positionNftAccount,
      tokenAMint: pool.tokenAMint,
      tokenBMint: pool.tokenBMint,
      tokenAVault: pool.tokenAVault,
      tokenBVault: pool.tokenBVault,
      tokenAProgram: pool.tokenAProgram,
      tokenBProgram: pool.tokenBProgram,
    });

    const { blockhash } = await connection.getLatestBlockhash();
    claimTx.recentBlockhash = blockhash;
    claimTx.feePayer = wallet.publicKey;

    await sendAndConfirmTransaction(connection, claimTx, [wallet], {
      commitment: "confirmed",
    });
    logger.info("Fees claimed before closing");
  } catch (err) {
    logger.warn("Could not claim fees (may be zero)", {
      error: String(err),
    });
  }

  // Fetch current pool and position state for the close call
  const poolState = await cpAmm.fetchPoolState(pool.address);
  const positionState = await cpAmm.fetchPositionState(positionAddress);

  // Get current point (slot or timestamp depending on pool activation type)
  const currentSlot = await connection.getSlot();

  // Fetch vestings for this position
  const vestings = await cpAmm.getAllVestingsByPosition(positionAddress);
  const vestingParams = vestings.map((v) => ({
    account: v.publicKey,
    vestingState: v.account,
  }));

  // Remove all liquidity and close position
  const closeTx = await cpAmm.removeAllLiquidityAndClosePosition({
    owner: wallet.publicKey,
    position: positionAddress,
    positionNftAccount,
    poolState,
    positionState,
    tokenAAmountThreshold: new BN(0),
    tokenBAmountThreshold: new BN(0),
    vestings: vestingParams,
    currentPoint: new BN(currentSlot),
  });

  const { blockhash } = await connection.getLatestBlockhash();
  closeTx.recentBlockhash = blockhash;
  closeTx.feePayer = wallet.publicKey;

  const sig = await sendAndConfirmTransaction(
    connection,
    closeTx,
    [wallet],
    { commitment: "confirmed" }
  );

  logger.info("Position closed", { signature: sig });
  return sig;
}

/**
 * Fetch all positions owned by our wallet.
 */
export async function getOwnPositions() {
  const cpAmm = getCpAmm();
  const wallet = getWallet();
  return cpAmm.getPositionsByUser(wallet.publicKey);
}
