// src/dlmm-buywall/types.ts
export type DlmmBuyWallDirection = "above" | "below" | "either";

/** Snapshot of a DLMM position at detection time. */
export interface DlmmPositionSnapshot {
  positionAddress: string;
  lbPairAddress: string;
  owner: string;
  /** Mint of token X (base). */
  tokenXMint: string;
  /** Mint of token Y (quote). */
  tokenYMint: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
  /** UI-unit amounts. */
  totalXAmount: number;
  totalYAmount: number;
  lowerBinId: number;
  upperBinId: number;
  /** Pool's current active bin. */
  activeBinId: number;
  binStep: number;
  /** Current price (Y per X) as decimal-shifted UI units. */
  currentPrice: number;
  rangeMinPrice: number;
  rangeMaxPrice: number;
  /** True if SOL is token Y; false if SOL is token X. */
  solIsTokenY: boolean;
  /** SOL value of the entire position (UI SOL units). */
  solValue: number;
  /** Fraction of position value held in SOL ∈ [0,1]. */
  solFraction: number;
  rangeOrientation: "above" | "below" | "across";
  detectedAt: string;
  txSignature: string;
}

export interface DetectedDlmmBuyWall extends DlmmPositionSnapshot {
  matchedReason: string;
}

export interface DlmmBuyWallFilterConfig {
  minSol: number;
  direction: DlmmBuyWallDirection;
  singleSideThreshold: number;
}

export type DlmmBuyWallCallback = (
  wall: DetectedDlmmBuyWall
) => Promise<void>;
