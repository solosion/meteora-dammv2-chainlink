import { DlmmPositionSnapshot } from "./types";

/**
 * Derived trading metrics for a detected wall.
 *
 * distancePct  — gap between current price and the *nearest* edge of the wall,
 *                in % of current price. A tight support wall (< 3%) means the
 *                price is sitting right on top of it.
 * spanPct      — width of the wall's price range in % of current price.
 * depthPct     — gap to the *farthest* edge (how deep the support zone reaches).
 */
export interface WallMetrics {
  distancePct: number;
  spanPct: number;
  depthPct: number;
}

export function computeWallMetrics(snapshot: {
  currentPrice: number;
  rangeMinPrice: number;
  rangeMaxPrice: number;
  rangeOrientation: DlmmPositionSnapshot["rangeOrientation"];
}): WallMetrics {
  const { currentPrice, rangeMinPrice, rangeMaxPrice, rangeOrientation } = snapshot;
  if (!(currentPrice > 0)) {
    return { distancePct: 0, spanPct: 0, depthPct: 0 };
  }

  const spanPct = ((rangeMaxPrice - rangeMinPrice) / currentPrice) * 100;

  if (rangeOrientation === "below") {
    // Support wall: nearest edge is the top of the range
    const distancePct = ((currentPrice - rangeMaxPrice) / currentPrice) * 100;
    const depthPct = ((currentPrice - rangeMinPrice) / currentPrice) * 100;
    return { distancePct: Math.max(0, distancePct), spanPct, depthPct };
  }
  if (rangeOrientation === "above") {
    // Resistance wall: nearest edge is the bottom of the range
    const distancePct = ((rangeMinPrice - currentPrice) / currentPrice) * 100;
    const depthPct = ((rangeMaxPrice - currentPrice) / currentPrice) * 100;
    return { distancePct: Math.max(0, distancePct), spanPct, depthPct };
  }
  return { distancePct: 0, spanPct, depthPct: 0 };
}

export interface WallTier {
  emoji: string;
  label: string;
}

export function classifyWallTier(solValue: number): WallTier {
  if (solValue >= 500) return { emoji: "🐋", label: "Whale" };
  if (solValue >= 200) return { emoji: "🦈", label: "Shark" };
  if (solValue >= 100) return { emoji: "🐬", label: "Dolphin" };
  return { emoji: "🐟", label: "Fish" };
}

/**
 * Human verdict on how actionable the wall is, based on distance to price.
 * Tight walls right under the price are the strongest support signal.
 */
export function classifySupportStrength(distancePct: number): string {
  if (distancePct <= 1) return "direkt am Preis";
  if (distancePct <= 3) return "sehr nah";
  if (distancePct <= 10) return "nah";
  if (distancePct <= 25) return "moderat entfernt";
  return "weit entfernt";
}
