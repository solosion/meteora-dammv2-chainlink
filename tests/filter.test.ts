import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  isSolPaired,
  isLiquidityAboveMin,
  isCreatorAllowed,
  shouldTailPool,
  FilterConfig,
  PoolCandidate,
} from "../src/filter/pool-filter";

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const RANDOM_TOKEN = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
const CREATOR_A = new PublicKey("11111111111111111111111111111111");

describe("isSolPaired", () => {
  it("returns true when tokenA is SOL", () => {
    expect(isSolPaired(SOL_MINT, RANDOM_TOKEN)).toBe(true);
  });
  it("returns true when tokenB is SOL", () => {
    expect(isSolPaired(RANDOM_TOKEN, SOL_MINT)).toBe(true);
  });
  it("returns false when neither is SOL", () => {
    expect(isSolPaired(RANDOM_TOKEN, RANDOM_TOKEN)).toBe(false);
  });
});

describe("isLiquidityAboveMin", () => {
  it("returns true above threshold", () => {
    expect(isLiquidityAboveMin(2.0, 1.0)).toBe(true);
  });
  it("returns false below threshold", () => {
    expect(isLiquidityAboveMin(0.5, 1.0)).toBe(false);
  });
  it("returns true at exact threshold", () => {
    expect(isLiquidityAboveMin(1.0, 1.0)).toBe(true);
  });
});

describe("isCreatorAllowed", () => {
  const creator = CREATOR_A.toBase58();
  it("allows all when whitelist and blacklist empty", () => {
    expect(isCreatorAllowed(creator, [], [])).toBe(true);
  });
  it("blocks when on blacklist", () => {
    expect(isCreatorAllowed(creator, [], [creator])).toBe(false);
  });
  it("blocks when whitelist set but creator not on it", () => {
    expect(isCreatorAllowed(creator, ["someOtherAddr"], [])).toBe(false);
  });
  it("allows when on whitelist", () => {
    expect(isCreatorAllowed(creator, [creator], [])).toBe(true);
  });
  it("blacklist takes priority over whitelist", () => {
    expect(isCreatorAllowed(creator, [creator], [creator])).toBe(false);
  });
});

describe("shouldTailPool", () => {
  const baseCandidate: PoolCandidate = {
    poolAddress: "pool123",
    tokenAMint: SOL_MINT,
    tokenBMint: RANDOM_TOKEN,
    creator: CREATOR_A.toBase58(),
    initialLiquiditySol: 2.0,
  };
  const baseConfig: FilterConfig = {
    minPoolLiquiditySol: 1.0,
    creatorWhitelist: [],
    creatorBlacklist: [],
  };

  it("accepts valid SOL-paired pool above min liquidity", () => {
    const result = shouldTailPool(baseCandidate, baseConfig);
    expect(result.accepted).toBe(true);
  });
  it("rejects non-SOL pool", () => {
    const candidate = { ...baseCandidate, tokenAMint: RANDOM_TOKEN };
    const result = shouldTailPool(candidate, baseConfig);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("SOL");
  });
  it("rejects low liquidity", () => {
    const candidate = { ...baseCandidate, initialLiquiditySol: 0.1 };
    const result = shouldTailPool(candidate, baseConfig);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("liquidity");
  });
  it("rejects blacklisted creator", () => {
    const cfg = { ...baseConfig, creatorBlacklist: [CREATOR_A.toBase58()] };
    const result = shouldTailPool(baseCandidate, cfg);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("creator");
  });
});
