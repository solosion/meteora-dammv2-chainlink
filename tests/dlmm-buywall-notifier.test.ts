import { describe, it, expect } from "vitest";
import { formatDlmmBuyWallMessage } from "../src/dlmm-buywall/notifier";
import { DetectedDlmmBuyWall } from "../src/dlmm-buywall/types";

const wall: DetectedDlmmBuyWall = {
  positionAddress: "PosBaseAddressInBase58Format1111111111111111",
  lbPairAddress: "LbPairAddressBase58Format11111111111111111",
  owner: "OwnerAddressInBase58Format1111111111111111",
  tokenXMint: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  tokenYMint: "So11111111111111111111111111111111111111112",
  tokenXDecimals: 6,
  tokenYDecimals: 9,
  totalXAmount: 0,
  totalYAmount: 75.5,
  lowerBinId: -100,
  upperBinId: -50,
  activeBinId: 0,
  binStep: 100,
  currentPrice: 1,
  rangeMinPrice: 0.5,
  rangeMaxPrice: 0.7,
  solIsTokenY: true,
  solValue: 75.5,
  solFraction: 1.0,
  rangeOrientation: "below",
  detectedAt: "2026-05-15T00:00:00.000Z",
  txSignature: "SigBase58Format1111111111111111111111111111",
  matchedReason: "75.5 SOL, 100% single-sided, range below",
};

describe("formatDlmmBuyWallMessage", () => {
  it("includes key data fields", () => {
    const msg = formatDlmmBuyWallMessage(wall);
    expect(msg).toContain("75.5");
    expect(msg).toContain("Buy Wall");
    expect(msg).toContain("DLMM");
    expect(msg).toContain(wall.lbPairAddress.substring(0, 8));
    expect(msg).toContain(wall.owner.substring(0, 8));
    expect(msg).toContain(wall.txSignature.substring(0, 8));
    expect(msg).toContain("below");
    expect(msg).toContain("-100");
    expect(msg).toContain("-50");
    expect(msg).toContain(wall.tokenXMint); // non-SOL token appears in Token: line
  });

  it("uses HTML", () => {
    const msg = formatDlmmBuyWallMessage(wall);
    expect(msg).toMatch(/<b>/);
    expect(msg).toMatch(/<code>/);
  });
});
