import { PublicKey } from "@solana/web3.js";
import DLMM, { getPriceOfBinByBinId } from "@meteora-ag/dlmm";
import { getConnection } from "../solana/connection";
import { logger } from "../utils/logger";
import { DlmmPositionSnapshot } from "./types";

const SOL_MINT = "So11111111111111111111111111111111111111112";

async function fetchDecimals(mint: PublicKey): Promise<number> {
  const connection = getConnection();
  const info = await connection.getParsedAccountInfo(mint);
  const decimals = (
    info as {
      value?: { data?: { parsed?: { info?: { decimals?: number } } } };
    }
  ).value?.data?.parsed?.info?.decimals;
  if (typeof decimals !== "number") {
    throw new Error(`Could not read decimals for ${mint.toBase58()}`);
  }
  return decimals;
}

function classify(
  active: number,
  low: number,
  high: number
): "above" | "below" | "across" {
  if (active < low) return "above";
  if (active > high) return "below";
  return "across";
}

export async function analyzeDlmmPosition(
  positionAddressStr: string,
  lbPairAddressStr: string,
  ownerStr: string,
  txSignature: string
): Promise<DlmmPositionSnapshot | null> {
  const connection = getConnection();
  const lbPairPubkey = new PublicKey(lbPairAddressStr);
  const ownerPubkey = new PublicKey(ownerStr);

  const dlmm = await DLMM.create(connection, lbPairPubkey);
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(ownerPubkey);
  const match = userPositions.find(
    (p) => p.publicKey.toBase58() === positionAddressStr
  );
  if (!match) {
    logger.debug("DLMM position not found for owner", {
      positionAddressStr,
      owner: ownerStr,
    });
    return null;
  }

  const tokenXMint: PublicKey = dlmm.lbPair.tokenXMint;
  const tokenYMint: PublicKey = dlmm.lbPair.tokenYMint;
  const solIsTokenX = tokenXMint.toBase58() === SOL_MINT;
  const solIsTokenY = tokenYMint.toBase58() === SOL_MINT;
  if (!solIsTokenX && !solIsTokenY) {
    logger.debug("DLMM pool has no SOL side, skipping", {
      lbPair: lbPairAddressStr,
    });
    return null;
  }

  const [decimalsX, decimalsY] = await Promise.all([
    fetchDecimals(tokenXMint),
    fetchDecimals(tokenYMint),
  ]);

  const binStep = dlmm.lbPair.binStep;
  const activeId = dlmm.lbPair.activeId;
  const { lowerBinId, upperBinId, totalXAmount, totalYAmount } =
    match.positionData;

  const totalXUi = Number(totalXAmount) / Math.pow(10, decimalsX);
  const totalYUi = Number(totalYAmount) / Math.pow(10, decimalsY);

  const decimalAdj = Math.pow(10, decimalsX - decimalsY);
  const currentPrice =
    getPriceOfBinByBinId(activeId, binStep).toNumber() * decimalAdj;
  const rangeMinPrice =
    getPriceOfBinByBinId(lowerBinId, binStep).toNumber() * decimalAdj;
  const rangeMaxPrice =
    getPriceOfBinByBinId(upperBinId, binStep).toNumber() * decimalAdj;

  const rangeOrientation = classify(activeId, lowerBinId, upperBinId);

  let solValue: number;
  let solFraction: number;
  if (solIsTokenY) {
    const xInSol = currentPrice > 0 ? totalXUi * currentPrice : 0;
    solValue = totalYUi + xInSol;
    solFraction = solValue > 0 ? totalYUi / solValue : 0;
  } else {
    const yInSol = currentPrice > 0 ? totalYUi / currentPrice : 0;
    solValue = totalXUi + yInSol;
    solFraction = solValue > 0 ? totalXUi / solValue : 0;
  }

  return {
    positionAddress: positionAddressStr,
    lbPairAddress: lbPairAddressStr,
    owner: match.positionData.owner.toBase58(),
    tokenXMint: tokenXMint.toBase58(),
    tokenYMint: tokenYMint.toBase58(),
    tokenXDecimals: decimalsX,
    tokenYDecimals: decimalsY,
    totalXAmount: totalXUi,
    totalYAmount: totalYUi,
    lowerBinId,
    upperBinId,
    activeBinId: activeId,
    binStep,
    currentPrice,
    rangeMinPrice,
    rangeMaxPrice,
    solIsTokenY,
    solValue,
    solFraction,
    rangeOrientation,
    detectedAt: new Date().toISOString(),
    txSignature,
  };
}
