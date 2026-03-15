/**
 * End-to-end pipeline test: simulates a new pool detection and verifies
 * the full flow from Data API fetch → filters → risk check → position opening.
 */

import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";

// ---- Mocks ----

jest.mock("../config", () => ({
  config: {
    solana: { rpcUrl: "https://mock-rpc.test", seedPhrase: "mock" },
    telegram: { botToken: "mock", adminChatId: "123" },
    risk: {
      maxPositionSizeSol: 0.5,
      maxTotalExposureSol: 5.0,
      maxOpenPositions: 10,
      maxMarketCapUsd: 1_000_000,
      minLiquidityUsd: 0,
    },
    watcher: {
      enabled: true,
      pollIntervalSeconds: 5,
      allowedTokenSuffixes: [],
    },
    monitor: { intervalSeconds: 30 },
    logLevel: "info",
  },
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock Data API
const mockGetPoolFromDataApi = jest.fn();
jest.mock("../meteora/dataapi", () => ({
  getPoolFromDataApi: (...args: any[]) => mockGetPoolFromDataApi(...args),
}));

// Mock pool state
const mockGetPoolByAddress = jest.fn();
jest.mock("../meteora/pools", () => ({
  getPoolByAddress: (...args: any[]) => mockGetPoolByAddress(...args),
}));

// Mock position opening
const mockOpenPosition = jest.fn();
jest.mock("../meteora/positions", () => ({
  openPosition: (...args: any[]) => mockOpenPosition(...args),
}));

// Mock wallet
const mockWalletPublicKey = new PublicKey("BH7jxWawKuXznJgxCG7nrkvxMy5cGn9FBPUtNaqanste");
jest.mock("../solana/wallet", () => ({
  getWallet: () => ({ publicKey: mockWalletPublicKey }),
  getWalletBalance: jest.fn().mockResolvedValue(7.0),
}));

// Mock Solana connection
jest.mock("../solana/connection", () => ({
  getConnection: () => ({}),
}));

// Mock tracker store
const mockAddPosition = jest.fn();
jest.mock("../tracker/store", () => {
  const positions: any[] = [];
  return {
    addPosition: (pos: any) => {
      const tracked = { ...pos, id: `pos_test_${Date.now()}`, status: "open" };
      positions.push(tracked);
      mockAddPosition(pos);
      return tracked;
    },
    getOpenPositions: () => positions.filter((p) => p.status === "open"),
    getOpenPositionCount: () => positions.filter((p) => p.status === "open").length,
    getTotalExposureSol: () =>
      positions
        .filter((p) => p.status === "open")
        .reduce((sum, p) => sum + (p.entryValueSol || 0), 0),
    getAllPositions: () => positions,
    getTotalPnl: () => 0,
    getPositionsSummary: () => "No positions",
    updatePositionValue: jest.fn(),
    closeTrackedPosition: jest.fn(),
  };
});

// Mock risk manager — use real implementation (it depends on store + wallet balance)
// We unmock it so it uses the mocked store/wallet
jest.mock("../risk/manager", () => {
  const original = jest.requireActual("../risk/manager");
  return {
    ...original,
  };
});

// Mock market data
jest.mock("../market/marketcap", () => ({
  getTokenMarketData: jest.fn().mockResolvedValue(null),
}));

// ---- Helpers that replicate the handleNewPool logic from index.ts ----

import { getPoolFromDataApi, DataApiPool } from "../meteora/dataapi";
import { getPoolByAddress, PoolInfo } from "../meteora/pools";
import { openPosition } from "../meteora/positions";
import { checkCanOpenPosition } from "../risk/manager";
import { addPosition } from "../tracker/store";
import { config } from "../config";

const WSOL = "So11111111111111111111111111111111111111112";

async function fetchPoolDataWithRetry(
  poolAddress: string,
  maxRetries: number = 1,
  delayMs: number = 0
): Promise<DataApiPool | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const data = await getPoolFromDataApi(poolAddress);
    if (data && data.tokenASymbol) return data;
  }
  return null;
}

/**
 * Replicates the full handleNewPool + processPool pipeline from index.ts
 */
async function runPipeline(poolAddress: string): Promise<{
  step: string;
  success: boolean;
  reason?: string;
  positionId?: string;
}> {
  // Step 1: Data API
  const poolData = await fetchPoolDataWithRetry(poolAddress);

  let tokenSymbol = "???";
  let poolName = poolAddress.substring(0, 8) + "...";
  let tvl = 0;

  if (poolData) {
    tokenSymbol =
      poolData.tokenAAddress === WSOL
        ? poolData.tokenBSymbol
        : poolData.tokenASymbol;
    poolName = poolData.poolName;
    tvl = poolData.tvl;
  }

  // Step 2: Suffix filter
  const allowedSuffixes = config.watcher.allowedTokenSuffixes;
  if (allowedSuffixes.length > 0 && tokenSymbol !== "???") {
    const symbolLower = tokenSymbol.toLowerCase();
    const nameLower = poolName.toLowerCase();
    const matchesSuffix = allowedSuffixes.some(
      (suffix) => symbolLower.endsWith(suffix) || nameLower.endsWith(suffix)
    );
    if (!matchesSuffix) {
      return { step: "suffix-filter", success: false, reason: `Token "${tokenSymbol}" blocked by suffix filter` };
    }
  }

  // Step 3: TVL check
  if (poolData && tvl > 0 && tvl < config.risk.minLiquidityUsd) {
    return { step: "tvl-check", success: false, reason: `TVL $${tvl} below minimum $${config.risk.minLiquidityUsd}` };
  }

  // Step 4: Risk check
  const positionSizeSol = config.risk.maxPositionSizeSol;
  const riskCheck = await checkCanOpenPosition(positionSizeSol);
  if (!riskCheck.allowed) {
    return { step: "risk-check", success: false, reason: riskCheck.reason };
  }

  // Step 5: Pool state
  const pool = await getPoolByAddress(new PublicKey(poolAddress));
  if (!pool) {
    return { step: "pool-state", success: false, reason: "Pool not found on-chain" };
  }

  // Step 6: Open position
  const solLamports = new BN(positionSizeSol * LAMPORTS_PER_SOL);
  const halfSol = solLamports.div(new BN(2));

  const result = await openPosition(pool, halfSol, halfSol);

  const tracked = addPosition({
    poolAddress,
    positionAddress: result.positionAddress.toBase58(),
    positionNftMint: result.positionNftMint.toBase58(),
    tokenAMint: pool.tokenAMint.toBase58(),
    tokenBMint: pool.tokenBMint.toBase58(),
    tokenAAmount: result.tokenAAmount.toString(),
    tokenBAmount: result.tokenBAmount.toString(),
    entryValueSol: positionSizeSol,
    openedAt: new Date().toISOString(),
    txSignature: result.txSignature,
  });

  return { step: "complete", success: true, positionId: tracked.id };
}

// ---- Tests ----

describe("Pipeline: handleNewPool → processPool → openPosition", () => {
  const MOCK_POOL = "F6L1RKAKwNuWwyCwweja6uxAkRv41XFTRWmg8tKGkn83";
  const MOCK_TOKEN_A = WSOL;
  const MOCK_TOKEN_B = "WLFinEv6ypjkczcS83FZqFpgFZYwQXutRbxGe7oC16g";
  const MOCK_POSITION = PublicKey.default.toBase58();
  const MOCK_NFT = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr").toBase58();

  beforeEach(() => {
    jest.clearAllMocks();

    // Default: Data API returns valid pool data
    mockGetPoolFromDataApi.mockResolvedValue({
      address: MOCK_POOL,
      tokenAAddress: MOCK_TOKEN_A,
      tokenBAddress: MOCK_TOKEN_B,
      tokenASymbol: "SOL",
      tokenBSymbol: "WLFI",
      tvl: 6_000_000,
      volume24h: 100_000,
      fees24h: 250,
      poolName: "WLFI-SOL",
    });

    // Default: Pool state found on-chain
    mockGetPoolByAddress.mockResolvedValue({
      address: new PublicKey(MOCK_POOL),
      tokenAMint: new PublicKey(MOCK_TOKEN_A),
      tokenBMint: new PublicKey(MOCK_TOKEN_B),
      tokenAVault: PublicKey.default,
      tokenBVault: PublicKey.default,
      sqrtPrice: new BN("1000000000"),
      sqrtMinPrice: new BN("100000000"),
      sqrtMaxPrice: new BN("10000000000"),
      liquidity: new BN("5000000000"),
      tokenAProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      tokenBProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    });

    // Default: Position opens successfully
    mockOpenPosition.mockResolvedValue({
      positionAddress: new PublicKey(MOCK_POSITION),
      positionNftMint: new PublicKey(MOCK_NFT),
      txSignature: "mock_tx_sig_12345",
      tokenAAmount: new BN(250_000_000),
      tokenBAmount: new BN(250_000_000),
    });
  });

  it("should complete the full pipeline successfully", async () => {
    const result = await runPipeline(MOCK_POOL);

    expect(result.step).toBe("complete");
    expect(result.success).toBe(true);
    expect(result.positionId).toBeDefined();

    // Verify all steps were called
    expect(mockGetPoolFromDataApi).toHaveBeenCalledWith(MOCK_POOL);
    expect(mockGetPoolByAddress).toHaveBeenCalled();
    expect(mockOpenPosition).toHaveBeenCalled();
    expect(mockAddPosition).toHaveBeenCalled();
  });

  it("should proceed even when Data API returns null (fallback)", async () => {
    mockGetPoolFromDataApi.mockResolvedValue(null);

    const result = await runPipeline(MOCK_POOL);

    // Should still open position (Data API failure is not blocking)
    expect(result.step).toBe("complete");
    expect(result.success).toBe(true);
  });

  it("should block when suffix filter is active and token doesn't match", async () => {
    // Temporarily set suffix filter
    const origSuffixes = config.watcher.allowedTokenSuffixes;
    (config.watcher as any).allowedTokenSuffixes = [".ido", ".launch"];

    const result = await runPipeline(MOCK_POOL);

    expect(result.step).toBe("suffix-filter");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("WLFI");

    // Restore
    (config.watcher as any).allowedTokenSuffixes = origSuffixes;
  });

  it("should block when TVL is below minimum", async () => {
    const origMin = config.risk.minLiquidityUsd;
    (config.risk as any).minLiquidityUsd = 10_000_000; // $10M minimum

    const result = await runPipeline(MOCK_POOL);

    expect(result.step).toBe("tvl-check");
    expect(result.success).toBe(false);

    (config.risk as any).minLiquidityUsd = origMin;
  });

  it("should block when pool is not found on-chain", async () => {
    mockGetPoolByAddress.mockResolvedValue(null);

    const result = await runPipeline(MOCK_POOL);

    expect(result.step).toBe("pool-state");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("not found on-chain");
  });

  it("should propagate openPosition errors", async () => {
    mockOpenPosition.mockRejectedValue(new Error("Simulation failed: insufficient funds"));

    await expect(runPipeline(MOCK_POOL)).rejects.toThrow("insufficient funds");
  });

  it("should track position after successful opening", async () => {
    const result = await runPipeline(MOCK_POOL);

    expect(result.success).toBe(true);
    expect(mockAddPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        poolAddress: MOCK_POOL,
        positionAddress: MOCK_POSITION,
        positionNftMint: MOCK_NFT,
        entryValueSol: 0.5,
        txSignature: "mock_tx_sig_12345",
      })
    );
  });

  it("should pass correct token amounts to openPosition", async () => {
    await runPipeline(MOCK_POOL);

    const [_pool, maxTokenA, maxTokenB] = mockOpenPosition.mock.calls[0];
    // 0.5 SOL / 2 = 0.25 SOL = 250_000_000 lamports
    expect(maxTokenA.toNumber()).toBe(250_000_000);
    expect(maxTokenB.toNumber()).toBe(250_000_000);
  });
});
