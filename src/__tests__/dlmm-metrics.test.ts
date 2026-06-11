import {
  computeWallMetrics,
  classifyWallTier,
  classifySupportStrength,
} from "../dlmm-buywall/metrics";

describe("computeWallMetrics", () => {
  it("computes distance/depth for a support wall below price", () => {
    // Price 100, wall from 80 to 95 → nearest edge 5% away, deepest 20%
    const m = computeWallMetrics({
      currentPrice: 100,
      rangeMinPrice: 80,
      rangeMaxPrice: 95,
      rangeOrientation: "below",
    });
    expect(m.distancePct).toBeCloseTo(5);
    expect(m.depthPct).toBeCloseTo(20);
    expect(m.spanPct).toBeCloseTo(15);
  });

  it("computes distance/depth for a resistance wall above price", () => {
    // Price 100, wall from 110 to 130 → nearest edge 10% above, farthest 30%
    const m = computeWallMetrics({
      currentPrice: 100,
      rangeMinPrice: 110,
      rangeMaxPrice: 130,
      rangeOrientation: "above",
    });
    expect(m.distancePct).toBeCloseTo(10);
    expect(m.depthPct).toBeCloseTo(30);
    expect(m.spanPct).toBeCloseTo(20);
  });

  it("clamps distance to 0 when wall touches the price", () => {
    const m = computeWallMetrics({
      currentPrice: 100,
      rangeMinPrice: 90,
      rangeMaxPrice: 101,
      rangeOrientation: "below",
    });
    expect(m.distancePct).toBe(0);
  });

  it("returns zeros for invalid price", () => {
    const m = computeWallMetrics({
      currentPrice: 0,
      rangeMinPrice: 1,
      rangeMaxPrice: 2,
      rangeOrientation: "below",
    });
    expect(m.distancePct).toBe(0);
    expect(m.spanPct).toBe(0);
    expect(m.depthPct).toBe(0);
  });
});

describe("classifyWallTier", () => {
  it("classifies tiers by SOL size", () => {
    expect(classifyWallTier(600).emoji).toBe("🐋");
    expect(classifyWallTier(250).emoji).toBe("🦈");
    expect(classifyWallTier(120).emoji).toBe("🐬");
    expect(classifyWallTier(60).emoji).toBe("🐟");
  });
});

describe("classifySupportStrength", () => {
  it("labels distance bands", () => {
    expect(classifySupportStrength(0.5)).toBe("direkt am Preis");
    expect(classifySupportStrength(2)).toBe("sehr nah");
    expect(classifySupportStrength(7)).toBe("nah");
    expect(classifySupportStrength(20)).toBe("moderat entfernt");
    expect(classifySupportStrength(50)).toBe("weit entfernt");
  });
});
