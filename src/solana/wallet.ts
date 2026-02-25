import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";
import { config } from "../config";
import { getConnection } from "./connection";
import { logger } from "../utils/logger";

let wallet: Keypair | null = null;

export function getWallet(): Keypair {
  if (!wallet) {
    const seedPhrase = config.solana.seedPhrase;
    const seed = bip39.mnemonicToSeedSync(seedPhrase);
    // Standard Solana derivation path (Phantom-compatible)
    const derivedSeed = derivePath(
      "m/44'/501'/0'/0'",
      seed.toString("hex")
    ).key;
    wallet = Keypair.fromSeed(derivedSeed);
    logger.info("Wallet loaded", {
      publicKey: wallet.publicKey.toBase58(),
    });
  }
  return wallet;
}

export async function getWalletBalance(): Promise<number> {
  const connection = getConnection();
  const balance = await connection.getBalance(getWallet().publicKey);
  return balance / LAMPORTS_PER_SOL;
}
