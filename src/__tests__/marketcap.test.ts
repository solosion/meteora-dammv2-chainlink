import { checkMarketCapEligibility } from "../market/marketcap";

// Mock the logger to suppress output during tests
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("checkMarketCapEligibility", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("should reject when market data is unavailable", async () => {
    // Mock fetch to return no pairs
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pairs: [] }),
    }) as jest.Mock;

    const result = await checkMarketCapEligibility("FakeToken111", 1_000_000);

    expect(result.eligible).toBe(false);
    expect(result.marketData).toBeNull();
    expect(result.reason).toContain("nicht abgerufen");
  });

  it("should reject when market cap exceeds threshold", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pairs: [
          {
            chainId: "solana",
            baseToken: { name: "TestToken", symbol: "TEST" },
            priceUsd: "0.001",
            marketCap: 5_000_000,
            liquidity: { usd: 50_000 },
            volume: { h24: 10_000 },
            priceChange: { h24: 5.0 },
          },
        ],
      }),
    }) as jest.Mock;

    const result = await checkMarketCapEligibility("TestMint123", 1_000_000);

    expect(result.eligible).toBe(false);
    expect(result.marketData).not.toBeNull();
    expect(result.marketData!.marketCap).toBe(5_000_000);
    expect(result.reason).toContain("überschreitet");
  });

  it("should approve when market cap is below threshold", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pairs: [
          {
            chainId: "solana",
            baseToken: { name: "SmallCoin", symbol: "SMOL" },
            priceUsd: "0.0001",
            marketCap: 500_000,
            liquidity: { usd: 20_000 },
            volume: { h24: 5_000 },
            priceChange: { h24: -2.0 },
          },
        ],
      }),
    }) as jest.Mock;

    const result = await checkMarketCapEligibility("SmolMint456", 1_000_000);

    expect(result.eligible).toBe(true);
    expect(result.marketData).not.toBeNull();
    expect(result.marketData!.symbol).toBe("SMOL");
    expect(result.marketData!.marketCap).toBe(500_000);
  });

  it("should reject when market cap is 0", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pairs: [
          {
            chainId: "solana",
            baseToken: { name: "ZeroCap", symbol: "ZERO" },
            priceUsd: "0.0",
            marketCap: 0,
            liquidity: { usd: 100 },
            volume: { h24: 0 },
            priceChange: { h24: 0 },
          },
        ],
      }),
    }) as jest.Mock;

    const result = await checkMarketCapEligibility("ZeroMint789", 1_000_000);

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("unbekannt oder 0");
  });

  it("should handle fetch errors gracefully", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Network error")) as jest.Mock;

    const result = await checkMarketCapEligibility("ErrorMint", 1_000_000);

    expect(result.eligible).toBe(false);
    expect(result.marketData).toBeNull();
  });
});
