import { describe, it, expect } from "vitest";
import { isDlmmBuyWall } from "../src/dlmm-buywall/filter";
import { DlmmPositionSnapshot } from "../src/dlmm-buywall/types";

function snap(over: Partial<DlmmPositionSnapshot> = {}): DlmmPositionSnapshot {
  return {
    positionAddress: "p1",
    lbPairAddress: "lb1",
    owner: "o1",
    tokenXMint: "X11111111111111111111111111111111",
    tokenYMint: "So11111111111111111111111111111111111111112",
    tokenXDecimals: 6,
    tokenYDecimals: 9,
    totalXAmount: 0,
    totalYAmount: 75,
    lowerBinId: -100,
    upperBinId: -50,
    activeBinId: 0,
    binStep: 100,
    currentPrice: 1,
    rangeMinPrice: 0.5,
    rangeMaxPrice: 0.7,
    solIsTokenY: true,
    solValue: 75,
    solFraction: 1.0,
    rangeOrientation: "below",
    detectedAt: "2026-05-15T00:00:00.000Z",
    txSignature: "sig1",
    ...over,
  };
}

const cfg = { minSol: 50, direction: "below" as const, singleSideThreshold: 0.95 };

describe("isDlmmBuyWall", () => {
  it("accepts 100% SOL, 75 SOL, range below current (the classic buy wall)", () => {
    expect(isDlmmBuyWall(snap(), cfg).matched).toBe(true);
  });

  it("rejects when below SOL threshold", () => {
    const r = isDlmmBuyWall(snap({ solValue: 30, totalYAmount: 30 }), cfg);
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/min_sol/i);
  });

  it("rejects when not single-sided enough", () => {
    const r = isDlmmBuyWall(snap({ solFraction: 0.5, totalXAmount: 100 }), cfg);
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/single_side/i);
  });

  it("rejects when range orientation is across", () => {
    expect(isDlmmBuyWall(snap({ rangeOrientation: "across" }), cfg).matched).toBe(false);
  });

  it("rejects when direction mismatched", () => {
    const r = isDlmmBuyWall(snap({ rangeOrientation: "above" }), cfg);
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/direction/i);
  });

  it("either accepts both", () => {
    expect(isDlmmBuyWall(snap({ rangeOrientation: "above" }), { ...cfg, direction: "either" }).matched).toBe(true);
    expect(isDlmmBuyWall(snap({ rangeOrientation: "below" }), { ...cfg, direction: "either" }).matched).toBe(true);
  });

  it("rejects when neither token is SOL", () => {
    const r = isDlmmBuyWall(
      snap({
        tokenYMint: "Other111111111111111111111111111111111111",
        solIsTokenY: false,
        solValue: 0,
        solFraction: 0,
      }),
      cfg
    );
    expect(r.matched).toBe(false);
  });
});
