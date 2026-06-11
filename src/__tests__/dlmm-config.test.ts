describe("dlmmBuywall config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env.SOLANA_RPC_URL = "https://example";
    process.env.TELEGRAM_BOT_TOKEN = "x";
    process.env.TELEGRAM_ADMIN_CHAT_ID = "1";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults: enabled, 50 SOL threshold, below direction, 0.95 single-side", () => {
    delete process.env.DLMM_BUYWALL_ENABLED;
    delete process.env.DLMM_BUYWALL_MIN_SOL;
    delete process.env.DLMM_BUYWALL_DIRECTION;
    delete process.env.DLMM_BUYWALL_SINGLE_SIDE_THRESHOLD;
    jest.resetModules();
    const { config } = require("../config");
    expect(config.dlmmBuywall.enabled).toBe(true);
    expect(config.dlmmBuywall.minSol).toBe(50);
    expect(config.dlmmBuywall.direction).toBe("below");
    expect(config.dlmmBuywall.singleSideThreshold).toBe(0.95);
  });

  it("reads overrides from env", () => {
    process.env.DLMM_BUYWALL_ENABLED = "true";
    process.env.DLMM_BUYWALL_MIN_SOL = "100";
    process.env.DLMM_BUYWALL_DIRECTION = "either";
    process.env.DLMM_BUYWALL_SINGLE_SIDE_THRESHOLD = "0.8";
    jest.resetModules();
    const { config } = require("../config");
    expect(config.dlmmBuywall.enabled).toBe(true);
    expect(config.dlmmBuywall.minSol).toBe(100);
    expect(config.dlmmBuywall.direction).toBe("either");
    expect(config.dlmmBuywall.singleSideThreshold).toBe(0.8);
  });
});
