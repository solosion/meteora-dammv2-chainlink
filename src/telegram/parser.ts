import { PublicKey } from "@solana/web3.js";
import { config } from "../config";
import { logger } from "../utils/logger";

export interface ParsedAlert {
  /** Extracted token mint addresses */
  tokenMints: PublicKey[];
  /** Pool address if directly mentioned */
  poolAddress: PublicKey | null;
  /** Raw message text */
  rawText: string;
  /** Sender info */
  senderId: string;
  /** Timestamp */
  timestamp: Date;
}

/**
 * Parse an incoming Telegram alert message to extract Solana addresses.
 * Identifies potential token mints and pool addresses.
 */
export function parseAlertMessage(
  text: string,
  senderId: string
): ParsedAlert | null {
  if (!text || text.trim().length === 0) return null;

  // Check if sender is allowed (if filter is configured)
  if (
    config.alertParser.allowedSenders.length > 0 &&
    !config.alertParser.allowedSenders.includes(senderId)
  ) {
    logger.debug(`Ignoring message from non-allowed sender: ${senderId}`);
    return null;
  }

  const regex = new RegExp(config.alertParser.tokenRegex, "g");
  const matches = text.match(regex);

  if (!matches || matches.length === 0) {
    logger.debug("No Solana addresses found in message");
    return null;
  }

  // Validate each match as a valid Solana public key
  const validAddresses: PublicKey[] = [];
  for (const match of matches) {
    try {
      const pubkey = new PublicKey(match);
      validAddresses.push(pubkey);
    } catch {
      // Not a valid public key, skip
    }
  }

  if (validAddresses.length === 0) return null;

  // Heuristic: If there are keywords suggesting a pool address
  const lowerText = text.toLowerCase();
  let poolAddress: PublicKey | null = null;
  const poolKeywords = ["pool", "lp", "amm", "damm"];
  const tokenKeywords = ["token", "mint", "ca", "contract"];

  // Try to distinguish pool addresses from token addresses
  // Look for labels near addresses in the text
  const tokenMints: PublicKey[] = [];

  for (const addr of validAddresses) {
    const addrStr = addr.toBase58();
    const idx = text.indexOf(addrStr);
    // Check surrounding context (50 chars before the address)
    const prefix = text.substring(Math.max(0, idx - 50), idx).toLowerCase();

    if (poolKeywords.some((kw) => prefix.includes(kw)) && !poolAddress) {
      poolAddress = addr;
    } else {
      tokenMints.push(addr);
    }
  }

  // If no clear pool address was found, all addresses are treated as token mints
  if (tokenMints.length === 0 && validAddresses.length > 0) {
    // If we only found a "pool" address, still treat first address as token mint
    tokenMints.push(validAddresses[0]);
    poolAddress = null;
  }

  logger.info("Alert parsed", {
    tokenMints: tokenMints.map((t) => t.toBase58()),
    poolAddress: poolAddress?.toBase58() || null,
    sender: senderId,
  });

  return {
    tokenMints,
    poolAddress,
    rawText: text,
    senderId,
    timestamp: new Date(),
  };
}
