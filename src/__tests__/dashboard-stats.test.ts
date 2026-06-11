import { computeWallStats } from "../dashboard/stats";
import { WallRecord } from "../dlmm-buywall/store";

const NOW = new Date("2026-06-11T12:00:00.000Z");

function wall(over: Partial<WallRecord & { firstSeenAt: string }> = {}): WallRecord & { firstSeenAt: string } {
  return {
    positionAddress: "pos" + Math.random(),
    lbPairAddress: "lb1",
    owner: "o1",
    tokenXMint: "TokenMintX",
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
    solFraction: 1,
    binCount: 51,
    solPerBin: 75 / 51,
    rangeOrientation: "below",
    detectedAt: NOW.toISOString(),
    txSignature: "sig",
    matchedReason: "test",
    signalScore: 65,
    firstSeenAt: NOW.toISOString(),
    ...over,
  };
}

describe("computeWallStats", () => {
  it("returns empty stats for no walls", () => {
    const s = computeWallStats([], NOW);
    expect(s.last24h.count).toBe(0);
    expect(s.allTime.count).toBe(0);
    expect(s.hourly).toHaveLength(24);
    expect(s.leaderboard).toHaveLength(0);
  });

  it("counts 24h vs all-time correctly", () => {
    const recent = wall({ solValue: 100, firstSeenAt: new Date(NOW.getTime() - 3600_000).toISOString() });
    const old = wall({ solValue: 50, firstSeenAt: new Date(NOW.getTime() - 48 * 3600_000).toISOString() });
    const s = computeWallStats([recent, old], NOW);
    expect(s.last24h.count).toBe(1);
    expect(s.last24h.totalSol).toBe(100);
    expect(s.last24h.biggestSol).toBe(100);
    expect(s.allTime.count).toBe(2);
    expect(s.allTime.totalSol).toBe(150);
  });

  it("buckets walls into the right hour", () => {
    const w = wall({ solValue: 80, firstSeenAt: new Date(NOW.getTime() - 2 * 3600_000).toISOString() });
    const s = computeWallStats([w], NOW);
    const nonEmpty = s.hourly.filter((b) => b.count > 0);
    expect(nonEmpty).toHaveLength(1);
    expect(nonEmpty[0].totalSol).toBe(80);
  });

  it("aggregates leaderboard by token mint, sorted by total SOL", () => {
    const tokenA1 = wall({ tokenXMint: "AAA", solValue: 60 });
    const tokenA2 = wall({ tokenXMint: "AAA", solValue: 90, tokenSymbol: "ALPHA" });
    const tokenB = wall({ tokenXMint: "BBB", solValue: 100 });
    const s = computeWallStats([tokenA1, tokenA2, tokenB], NOW);
    expect(s.leaderboard).toHaveLength(2);
    expect(s.leaderboard[0].tokenMint).toBe("AAA");
    expect(s.leaderboard[0].totalSol).toBe(150);
    expect(s.leaderboard[0].wallCount).toBe(2);
    expect(s.leaderboard[0].tokenSymbol).toBe("ALPHA");
    expect(s.leaderboard[1].tokenMint).toBe("BBB");
  });

  it("uses tokenY mint when SOL is tokenX", () => {
    const w = wall({ solIsTokenY: false, tokenXMint: "SOLMINT", tokenYMint: "OTHER" });
    const s = computeWallStats([w], NOW);
    expect(s.leaderboard[0].tokenMint).toBe("OTHER");
  });
});
