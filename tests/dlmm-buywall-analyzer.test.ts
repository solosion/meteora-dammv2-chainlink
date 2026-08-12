// tests/dlmm-buywall-analyzer.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";

const mockGetPositionsByUserAndLbPair = vi.fn();
const mockGetParsedAccountInfo = vi.fn();
const mockGetPriceOfBinByBinId = vi.fn();
const mockDlmmCreate = vi.fn();

vi.mock("@meteora-ag/dlmm", () => ({
  default: {
    create: (...args: unknown[]) => mockDlmmCreate(...args),
  },
  getPriceOfBinByBinId: (...args: unknown[]) => mockGetPriceOfBinByBinId(...args),
}));

vi.mock("../src/solana/connection", () => ({
  getConnection: () => ({ getParsedAccountInfo: mockGetParsedAccountInfo }),
}));

const SOL_MINT = "So11111111111111111111111111111111111111112";
// TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA = SPL Token program (valid base58, 32 bytes)
const TOKEN_X = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v = USDC mint (valid base58, 32 bytes)
const OTHER_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Deterministic valid base58 pubkeys (seeded from "position", "lbpair", "owner")
const POSITION_PK = "FzAbJaP1e3QkifcXi2Xm2r2DG5LiRQ1Y4kt5PVHm7qNz";
const LBPAIR_PK = "5byWd1Nib4aYj1KckBQfifPbWF69DxwpmHcSuxiypbXS";
const OWNER_PK = "FseuYDfayH186rL2ALfk3ej5c7uoj3JcDfCQxupobqFt";

describe("analyzeDlmmPosition", () => {
  beforeEach(() => {
    mockGetPositionsByUserAndLbPair.mockReset();
    mockGetParsedAccountInfo.mockReset();
    mockGetPriceOfBinByBinId.mockReset();
    mockDlmmCreate.mockReset();
    mockGetParsedAccountInfo.mockImplementation(async (pk: PublicKey) => ({
      value: {
        data: { parsed: { info: { decimals: pk.toBase58() === SOL_MINT ? 9 : 6 } } },
      },
    }));
    mockGetPriceOfBinByBinId.mockImplementation((binId: number) =>
      new Decimal(1.0001).pow(binId)
    );
  });

  it("classifies single-sided SOL buy wall below active bin (SOL=tokenY)", async () => {
    mockDlmmCreate.mockResolvedValue({
      lbPair: {
        activeId: 0,
        binStep: 100,
        tokenXMint: new PublicKey(TOKEN_X),
        tokenYMint: new PublicKey(SOL_MINT),
      },
      getPositionsByUserAndLbPair: mockGetPositionsByUserAndLbPair,
    });
    mockGetPositionsByUserAndLbPair.mockResolvedValue({
      activeBin: { binId: 0 },
      userPositions: [
        {
          publicKey: new PublicKey(POSITION_PK),
          positionData: {
            totalXAmount: "0",
            totalYAmount: (75 * 1e9).toString(),
            lowerBinId: -100,
            upperBinId: -50,
            owner: new PublicKey(OWNER_PK),
          },
        },
      ],
    });

    const { analyzeDlmmPosition } = await import("../src/dlmm-buywall/analyzer");
    const result = await analyzeDlmmPosition(
      POSITION_PK,
      LBPAIR_PK,
      OWNER_PK,
      "sig1"
    );

    expect(result).not.toBeNull();
    expect(result!.solIsTokenY).toBe(true);
    expect(result!.rangeOrientation).toBe("below");
    expect(result!.solValue).toBeGreaterThan(74);
    expect(result!.solValue).toBeLessThan(76);
    expect(result!.solFraction).toBeGreaterThan(0.95);
    expect(result!.owner).toBe(OWNER_PK);
  });

  it("returns null when neither mint is SOL", async () => {
    mockDlmmCreate.mockResolvedValue({
      lbPair: {
        activeId: 0,
        binStep: 100,
        tokenXMint: new PublicKey(TOKEN_X),
        tokenYMint: new PublicKey(OTHER_MINT),
      },
      getPositionsByUserAndLbPair: mockGetPositionsByUserAndLbPair,
    });
    mockGetPositionsByUserAndLbPair.mockResolvedValue({
      userPositions: [{
        publicKey: new PublicKey(POSITION_PK),
        positionData: {
          totalXAmount: "0",
          totalYAmount: "0",
          lowerBinId: -1,
          upperBinId: 1,
          owner: new PublicKey(OWNER_PK),
        },
      }],
    });
    const { analyzeDlmmPosition } = await import("../src/dlmm-buywall/analyzer");
    expect(
      await analyzeDlmmPosition(POSITION_PK, LBPAIR_PK, OWNER_PK, "sig1")
    ).toBeNull();
  });
});
