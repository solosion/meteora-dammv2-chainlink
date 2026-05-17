import { DlmmPositionSnapshot, DlmmBuyWallFilterConfig } from "./types";

export interface DlmmFilterResult {
  matched: boolean;
  reason: string;
}

export function isDlmmBuyWall(
  snapshot: DlmmPositionSnapshot,
  config: DlmmBuyWallFilterConfig
): DlmmFilterResult {
  if (snapshot.solValue < config.minSol) {
    return { matched: false, reason: `min_sol: ${snapshot.solValue.toFixed(2)} < ${config.minSol}` };
  }
  if (snapshot.solFraction < config.singleSideThreshold) {
    return {
      matched: false,
      reason: `single_side: ${(snapshot.solFraction * 100).toFixed(1)}% < ${(config.singleSideThreshold * 100).toFixed(1)}%`,
    };
  }
  if (snapshot.rangeOrientation === "across") {
    return { matched: false, reason: "across: bin range straddles active bin" };
  }
  if (config.direction !== "either" && snapshot.rangeOrientation !== config.direction) {
    return {
      matched: false,
      reason: `direction: range is ${snapshot.rangeOrientation}, want ${config.direction}`,
    };
  }
  return {
    matched: true,
    reason: `${snapshot.solValue.toFixed(2)} SOL, ${(snapshot.solFraction * 100).toFixed(1)}% single-sided, range ${snapshot.rangeOrientation}`,
  };
}
