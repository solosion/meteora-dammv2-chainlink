import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("dlmmBuywall config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.SOLANA_RPC_URL = "https://example";
    process.env.SOLANA_SEED_PHRASE = "test test test test test test test test test test test junk";
    process.env.TELEGRAM_BOT_TOKEN = "x";
    process.env.TELEGRAM_ADMIN_CHAT_ID = "1";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("defaults: disabled, 50 SOL threshold, below direction, 0.95 single-side", async () => {
    delete process.env.DLMM_BUYWALL_ENABLED;
    delete process.env.DLMM_BUYWALL_MIN_SOL;
    delete process.env.DLMM_BUYWALL_DIRECTION;
    delete process.env.DLMM_BUYWALL_SINGLE_SIDE_THRESHOLD;
    vi.resetModules();
    const { config } = await import("../src/config");
    expect(config.dlmmBuywall.enabled).toBe(false);
    expect(config.dlmmBuywall.minSol).toBe(50);
    expect(config.dlmmBuywall.direction).toBe("below");
    expect(config.dlmmBuywall.singleSideThreshold).toBe(0.95);
  });

  it("reads overrides", async () => {
    process.env.DLMM_BUYWALL_ENABLED = "true";
    process.env.DLMM_BUYWALL_MIN_SOL = "100";
    process.env.DLMM_BUYWALL_DIRECTION = "either";
    process.env.DLMM_BUYWALL_SINGLE_SIDE_THRESHOLD = "0.8";
    vi.resetModules();
    const { config } = await import("../src/config");
    expect(config.dlmmBuywall.enabled).toBe(true);
    expect(config.dlmmBuywall.minSol).toBe(100);
    expect(config.dlmmBuywall.direction).toBe("either");
    expect(config.dlmmBuywall.singleSideThreshold).toBe(0.8);
  });
});
