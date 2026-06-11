export type DlmmBuyWallDirection = "above" | "below" | "either";

export interface DlmmPositionSnapshot {
  positionAddress: string;
  lbPairAddress: string;
  owner: string;
  tokenXMint: string;
  tokenYMint: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
  totalXAmount: number;
  totalYAmount: number;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  binStep: number;
  currentPrice: number;
  rangeMinPrice: number;
  rangeMaxPrice: number;
  solIsTokenY: boolean;
  solValue: number;
  solFraction: number;
  /** How many bins this position spans. */
  binCount: number;
  /** SOL per bin — measures how concentrated the wall is. */
  solPerBin: number;
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
