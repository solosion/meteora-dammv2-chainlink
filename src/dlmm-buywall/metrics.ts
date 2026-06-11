import { DlmmPositionSnapshot } from "./types";

export interface WallMetrics {
  distancePct: number;
  spanPct: number;
  depthPct: number;
  solPerBin: number;
  binCount: number;
}

export function computeWallMetrics(snapshot: {
  currentPrice: number;
  rangeMinPrice: number;
  rangeMaxPrice: number;
  rangeOrientation: DlmmPositionSnapshot["rangeOrientation"];
  solPerBin?: number;
  binCount?: number;
}): WallMetrics {
  const { currentPrice, rangeMinPrice, rangeMaxPrice, rangeOrientation } = snapshot;
  if (!(currentPrice > 0)) {
    return { distancePct: 0, spanPct: 0, depthPct: 0, solPerBin: snapshot.solPerBin ?? 0, binCount: snapshot.binCount ?? 0 };
  }

  const spanPct = ((rangeMaxPrice - rangeMinPrice) / currentPrice) * 100;
  const solPerBin = snapshot.solPerBin ?? 0;
  const binCount = snapshot.binCount ?? 0;

  if (rangeOrientation === "below") {
    const distancePct = ((currentPrice - rangeMaxPrice) / currentPrice) * 100;
    const depthPct = ((currentPrice - rangeMinPrice) / currentPrice) * 100;
    return { distancePct: Math.max(0, distancePct), spanPct, depthPct, solPerBin, binCount };
  }
  if (rangeOrientation === "above") {
    const distancePct = ((rangeMinPrice - currentPrice) / currentPrice) * 100;
    const depthPct = ((rangeMaxPrice - currentPrice) / currentPrice) * 100;
    return { distancePct: Math.max(0, distancePct), spanPct, depthPct, solPerBin, binCount };
  }
  return { distancePct: 0, spanPct, depthPct: 0, solPerBin, binCount };
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
 * Relative tier: compare wall size to token's 24h volume.
 * A 100 SOL wall on a token with 200 SOL volume is massive (50%).
 * A 100 SOL wall on a token with 100K SOL volume is irrelevant.
 */
export function classifyRelativeTier(solValue: number, volume24hUsd: number, solPriceUsd: number): {
  wallToVolumePct: number;
  label: string;
} {
  if (!volume24hUsd || !solPriceUsd || solPriceUsd <= 0) {
    return { wallToVolumePct: 0, label: "?" };
  }
  const wallUsd = solValue * solPriceUsd;
  const pct = (wallUsd / volume24hUsd) * 100;
  let label: string;
  if (pct >= 20) label = "massiv";
  else if (pct >= 5) label = "signifikant";
  else if (pct >= 1) label = "moderat";
  else label = "gering";
  return { wallToVolumePct: pct, label };
}

export function classifySupportStrength(distancePct: number): string {
  if (distancePct <= 1) return "direkt am Preis";
  if (distancePct <= 3) return "sehr nah";
  if (distancePct <= 10) return "nah";
  if (distancePct <= 25) return "moderat entfernt";
  return "weit entfernt";
}

/**
 * Trading signal score 0–100.
 *
 * Factors (each 0–25 points):
 *  1. Size (absolute SOL value)
 *  2. Proximity (how close the wall is to current price)
 *  3. Concentration (SOL per bin — dense walls are harder to break)
 *  4. Single-sidedness (100% SOL = pure conviction)
 *
 * Volume context (when wall-to-volume ratio is known): ≥5% adds up to 10
 * bonus points, <1% subtracts 15 — a wall that's tiny vs. daily volume
 * cannot hold the price.
 */
export function computeSignalScore(params: {
  solValue: number;
  distancePct: number;
  solPerBin: number;
  solFraction: number;
  wallToVolumePct?: number;
}): number {
  const { solValue, distancePct, solPerBin, solFraction } = params;

  // 1. Size: 50 SOL = 5pts, 200 = 15pts, 500+ = 25pts (log scale)
  const sizeScore = Math.min(25, Math.max(0, Math.log10(Math.max(1, solValue)) * 9.2 - 6));

  // 2. Proximity: 0% = 25pts, 3% = 18pts, 10% = 10pts, 30%+ = 0pts
  const proxScore = Math.min(25, Math.max(0, 25 - distancePct * 0.83));

  // 3. Concentration: >10 SOL/bin = 25pts, 1 = 10pts, 0.1 = 2pts
  const concScore = Math.min(25, Math.max(0, (Math.log10(Math.max(0.01, solPerBin)) + 1) * 12.5));

  // 4. Single-sidedness: 1.0 = 25pts, 0.95 = 20pts, 0.8 = 5pts
  const ssScore = Math.min(25, Math.max(0, (solFraction - 0.75) * 100));

  let score = sizeScore + proxScore + concScore + ssScore;

  // Volume context: a wall that is big relative to the token's 24h volume
  // can actually hold the price (bonus); a wall that is tiny relative to
  // volume gets eaten through in minutes (malus).
  if (params.wallToVolumePct !== undefined && params.wallToVolumePct > 0) {
    if (params.wallToVolumePct >= 5) {
      score += Math.min(10, params.wallToVolumePct * 0.5);
    } else if (params.wallToVolumePct < 1) {
      score -= 15;
    }
  }

  return Math.round(Math.min(100, Math.max(0, score)));
}

export function scoreLabel(score: number): { label: string; emoji: string } {
  if (score >= 80) return { label: "Starkes Signal", emoji: "🔥" };
  if (score >= 60) return { label: "Gutes Signal", emoji: "📈" };
  if (score >= 40) return { label: "Mittel", emoji: "📊" };
  if (score >= 20) return { label: "Schwach", emoji: "📉" };
  return { label: "Rauschen", emoji: "💤" };
}
