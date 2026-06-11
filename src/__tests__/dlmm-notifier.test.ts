import { formatDlmmBuyWallMessage } from "../dlmm-buywall/notifier";
import { WallRecord } from "../dlmm-buywall/store";

const wall: WallRecord = {
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
  binCount: 51,
  solPerBin: 75.5 / 51,
  rangeOrientation: "below",
  detectedAt: "2026-05-15T00:00:00.000Z",
  txSignature: "SigBase58Format1111111111111111111111111111",
  matchedReason: "75.5 SOL, 100% single-sided, range below",
  tokenSymbol: "WIF",
  tokenName: "dogwifhat",
  volume24hUsd: 500_000,
  solPriceUsd: 150,
  marketCapUsd: 3_000_000,
  priceChange24h: -5.3,
};

describe("formatDlmmBuyWallMessage", () => {
  it("includes score, key data, and volume context", () => {
    const msg = formatDlmmBuyWallMessage(wall);
    expect(msg).toContain("75.5");
    expect(msg).toContain("Buy Wall");
    expect(msg).toContain("Score");
    expect(msg).toContain("/100");
    expect(msg).toContain("WIF");
    expect(msg).toContain("SOL/Bin");
    expect(msg).toContain("Konzentration");
    expect(msg).toContain("Vol 24h");
    expect(msg).toContain(wall.lbPairAddress.substring(0, 8));
    expect(msg).toContain(wall.owner.substring(0, 8));
    expect(msg).toContain(wall.tokenXMint);
  });

  it("includes links to solscan, meteora, dexscreener", () => {
    const msg = formatDlmmBuyWallMessage(wall);
    expect(msg).toContain("solscan.io");
    expect(msg).toContain("meteora.ag");
    expect(msg).toContain("dexscreener.com");
  });

  it("uses HTML formatting", () => {
    const msg = formatDlmmBuyWallMessage(wall);
    expect(msg).toMatch(/<b>/);
    expect(msg).toMatch(/<code>/);
  });
});
