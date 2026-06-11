import {
  computeWallMetrics,
  classifyWallTier,
  classifySupportStrength,
  classifyRelativeTier,
  computeSignalScore,
  scoreLabel,
} from "../dlmm-buywall/metrics";

describe("computeWallMetrics", () => {
  it("computes distance/depth for a support wall below price", () => {
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
  });

  it("includes solPerBin and binCount when provided", () => {
    const m = computeWallMetrics({
      currentPrice: 100,
      rangeMinPrice: 90,
      rangeMaxPrice: 95,
      rangeOrientation: "below",
      solPerBin: 5.5,
      binCount: 20,
    });
    expect(m.solPerBin).toBe(5.5);
    expect(m.binCount).toBe(20);
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

describe("classifyRelativeTier", () => {
  it("marks wall as massive when >= 20% of volume", () => {
    // 100 SOL * $150 = $15K wall, volume = $50K → 30%
    const r = classifyRelativeTier(100, 50_000, 150);
    expect(r.label).toBe("massiv");
    expect(r.wallToVolumePct).toBeCloseTo(30);
  });

  it("marks wall as gering when < 1% of volume", () => {
    const r = classifyRelativeTier(50, 5_000_000, 150);
    expect(r.label).toBe("gering");
    expect(r.wallToVolumePct).toBeLessThan(1);
  });

  it("returns ? when volume or solPrice is missing", () => {
    expect(classifyRelativeTier(100, 0, 150).label).toBe("?");
    expect(classifyRelativeTier(100, 100_000, 0).label).toBe("?");
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

describe("computeSignalScore", () => {
  it("high score for large, close, concentrated, single-sided wall", () => {
    const score = computeSignalScore({
      solValue: 500,
      distancePct: 1,
      solPerBin: 50,
      solFraction: 1.0,
      wallToVolumePct: 25,
    });
    expect(score).toBeGreaterThanOrEqual(75);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("low score for small, distant, spread wall", () => {
    const score = computeSignalScore({
      solValue: 50,
      distancePct: 30,
      solPerBin: 0.5,
      solFraction: 0.96,
    });
    expect(score).toBeLessThan(45);
  });

  it("volume bonus increases score", () => {
    const base = computeSignalScore({
      solValue: 200,
      distancePct: 3,
      solPerBin: 10,
      solFraction: 1.0,
    });
    const withVol = computeSignalScore({
      solValue: 200,
      distancePct: 3,
      solPerBin: 10,
      solFraction: 1.0,
      wallToVolumePct: 20,
    });
    expect(withVol).toBeGreaterThan(base);
  });

  it("clamps to 0-100 range", () => {
    const s1 = computeSignalScore({ solValue: 0, distancePct: 100, solPerBin: 0, solFraction: 0 });
    const s2 = computeSignalScore({ solValue: 100000, distancePct: 0, solPerBin: 1000, solFraction: 1, wallToVolumePct: 100 });
    expect(s1).toBeGreaterThanOrEqual(0);
    expect(s2).toBeLessThanOrEqual(100);
  });
});

describe("scoreLabel", () => {
  it("maps scores to labels", () => {
    expect(scoreLabel(85).label).toBe("Starkes Signal");
    expect(scoreLabel(65).label).toBe("Gutes Signal");
    expect(scoreLabel(45).label).toBe("Mittel");
    expect(scoreLabel(25).label).toBe("Schwach");
    expect(scoreLabel(10).label).toBe("Rauschen");
  });
});
