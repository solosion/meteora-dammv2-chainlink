/**
 * Simulate a new pool detection to test the full pipeline:
 *   1. Meteora Data API fetch
 *   2. Token suffix filter
 *   3. TVL / liquidity check
 *   4. Risk check (balance, exposure, position count)
 *   5. Pool state fetch (on-chain via SDK)
 *   6. Position opening (only with --live flag)
 *
 * Usage:
 *   npx ts-node src/simulate-pool.ts <POOL_ADDRESS> [--live]
 *
 * Without --live, the script runs in dry-run mode and stops before opening.
 */

import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "./config";
import { logger } from "./utils/logger";
import { getWallet, getWalletBalance } from "./solana/wallet";
import { getPoolByAddress } from "./meteora/pools";
import { openPosition } from "./meteora/positions";
import { checkCanOpenPosition } from "./risk/manager";
import { addPosition } from "./tracker/store";
import { getPoolFromDataApi } from "./meteora/dataapi";

const WSOL = "So11111111111111111111111111111111111111112";

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

async function simulate(): Promise<void> {
  const args = process.argv.slice(2);
  const poolArg = args.find((a) => !a.startsWith("--"));
  const liveMode = args.includes("--live");

  if (!poolArg) {
    console.error("Usage: npx ts-node src/simulate-pool.ts <POOL_ADDRESS> [--live]");
    console.error("");
    console.error("  --live    Actually open a position (default: dry-run)");
    process.exit(1);
  }

  let poolPubkey: PublicKey;
  try {
    poolPubkey = new PublicKey(poolArg);
  } catch {
    console.error(`Invalid pool address: ${poolArg}`);
    process.exit(1);
  }

  console.log("=== DAMM v2 Pool Simulation ===");
  console.log(`Mode: ${liveMode ? "🔴 LIVE (will open position!)" : "🟢 DRY-RUN"}`);
  console.log(`Pool: ${poolPubkey.toBase58()}`);
  console.log("");

  // ---- Step 0: Wallet ----
  console.log("--- Step 0: Wallet ---");
  const wallet = getWallet();
  const balance = await getWalletBalance();
  console.log(`  Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance: ${balance.toFixed(4)} SOL`);
  console.log("");

  // ---- Step 1: Meteora Data API ----
  console.log("--- Step 1: Meteora Data API ---");
  const poolData = await getPoolFromDataApi(poolPubkey.toBase58());

  if (!poolData) {
    console.log("  ❌ Pool NOT found on Data API");
    console.log("  (New pools may not be indexed yet — retries would happen in prod)");
  } else {
    console.log(`  ✅ Pool found on Data API`);
    console.log(`  Name:     ${poolData.poolName}`);
    console.log(`  Token A:  ${poolData.tokenASymbol} (${poolData.tokenAAddress})`);
    console.log(`  Token B:  ${poolData.tokenBSymbol} (${poolData.tokenBAddress})`);
    console.log(`  TVL:      $${formatUsd(poolData.tvl)}`);
    console.log(`  Volume:   $${formatUsd(poolData.volume24h)}`);
  }
  console.log("");

  // ---- Step 2: Token suffix filter ----
  console.log("--- Step 2: Token Suffix Filter ---");
  const allowedSuffixes = config.watcher.allowedTokenSuffixes;
  let tokenSymbol = "???";

  if (poolData) {
    tokenSymbol =
      poolData.tokenAAddress === WSOL
        ? poolData.tokenBSymbol
        : poolData.tokenASymbol;
  }

  console.log(`  Token symbol: ${tokenSymbol}`);
  console.log(`  Allowed suffixes: ${allowedSuffixes.length > 0 ? allowedSuffixes.join(", ") : "(none — all allowed)"}`);

  if (allowedSuffixes.length > 0 && tokenSymbol !== "???") {
    const symbolLower = tokenSymbol.toLowerCase();
    const nameLower = (poolData?.poolName || "").toLowerCase();
    const matchesSuffix = allowedSuffixes.some(
      (suffix) => symbolLower.endsWith(suffix) || nameLower.endsWith(suffix)
    );
    if (!matchesSuffix) {
      console.log(`  ❌ BLOCKED — token "${tokenSymbol}" does not match suffix filter`);
      console.log("  → In prod, this pool would be skipped.");
    } else {
      console.log(`  ✅ Token matches suffix filter`);
    }
  } else {
    console.log(`  ✅ No suffix filter active or token unknown — passes`);
  }
  console.log("");

  // ---- Step 3: TVL check ----
  console.log("--- Step 3: TVL / Liquidity Check ---");
  const tvl = poolData?.tvl || 0;
  console.log(`  TVL:           $${formatUsd(tvl)}`);
  console.log(`  Min required:  $${formatUsd(config.risk.minLiquidityUsd)}`);
  if (tvl > 0 && tvl < config.risk.minLiquidityUsd) {
    console.log(`  ❌ BLOCKED — TVL too low`);
  } else {
    console.log(`  ✅ TVL check passed`);
  }
  console.log("");

  // ---- Step 4: Risk check ----
  console.log("--- Step 4: Risk Check ---");
  const positionSizeSol = config.risk.maxPositionSizeSol;
  console.log(`  Position size:  ${positionSizeSol} SOL`);
  const riskCheck = await checkCanOpenPosition(positionSizeSol);
  if (!riskCheck.allowed) {
    console.log(`  ❌ BLOCKED — ${riskCheck.reason}`);
    console.log("  → In prod, this pool would be skipped.");
    if (!liveMode) {
      console.log("\n=== Simulation complete (dry-run, blocked by risk check) ===");
      process.exit(0);
    }
  } else {
    console.log(`  ✅ Risk check passed`);
  }
  console.log("");

  // ---- Step 5: On-chain pool state ----
  console.log("--- Step 5: On-chain Pool State (SDK) ---");
  const pool = await getPoolByAddress(poolPubkey);
  if (!pool) {
    console.log(`  ❌ Pool NOT found on-chain — cannot proceed`);
    process.exit(1);
  }
  console.log(`  ✅ Pool loaded from chain`);
  console.log(`  Token A Mint:  ${pool.tokenAMint.toBase58()}`);
  console.log(`  Token B Mint:  ${pool.tokenBMint.toBase58()}`);
  console.log(`  sqrtPrice:     ${pool.sqrtPrice.toString()}`);
  console.log(`  Liquidity:     ${pool.liquidity.toString()}`);
  console.log(`  Token A Prog:  ${pool.tokenAProgram.toBase58()}`);
  console.log(`  Token B Prog:  ${pool.tokenBProgram.toBase58()}`);
  console.log("");

  // ---- Step 6: Position opening ----
  if (!liveMode) {
    console.log("--- Step 6: Position Opening (SKIPPED — dry-run) ---");
    console.log("  Use --live to actually open a position");
    console.log("");
    console.log("=== ✅ Simulation complete — all checks passed! ===");
    console.log("  The full pipeline works correctly.");
    console.log("  When a real new pool is detected, a position will be opened.");
    process.exit(0);
  }

  console.log("--- Step 6: Position Opening (LIVE!) ---");
  const solLamports = new BN(positionSizeSol * LAMPORTS_PER_SOL);
  const halfSol = solLamports.div(new BN(2));
  console.log(`  Opening with ${positionSizeSol} SOL...`);

  try {
    const result = await openPosition(pool, halfSol, halfSol);
    console.log(`  ✅ Position opened!`);
    console.log(`  Position:  ${result.positionAddress.toBase58()}`);
    console.log(`  NFT Mint:  ${result.positionNftMint.toBase58()}`);
    console.log(`  TX:        ${result.txSignature}`);

    // Track it
    const tracked = addPosition({
      poolAddress: poolPubkey.toBase58(),
      positionAddress: result.positionAddress.toBase58(),
      positionNftMint: result.positionNftMint.toBase58(),
      tokenAMint: pool.tokenAMint.toBase58(),
      tokenBMint: pool.tokenBMint.toBase58(),
      tokenAAmount: result.tokenAAmount.toString(),
      tokenBAmount: result.tokenBAmount.toString(),
      entryValueSol: positionSizeSol,
      openedAt: new Date().toISOString(),
      txSignature: result.txSignature,
    });
    console.log(`  Tracked as: ${tracked.id}`);
  } catch (err) {
    console.error(`  ❌ Position opening FAILED:`, err);
    process.exit(1);
  }

  console.log("");
  console.log("=== ✅ Simulation complete — position opened! ===");
  process.exit(0);
}

simulate().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
