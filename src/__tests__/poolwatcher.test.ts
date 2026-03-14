import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

// Mock config before importing anything that uses it
jest.mock("../config", () => ({
  config: {
    solana: { rpcUrl: "https://mock-rpc.test" },
    watcher: {
      enabled: true,
      pollIntervalSeconds: 5,
      allowedTokenSuffixes: [],
    },
    logLevel: "info",
  },
}));

// Mock logger
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock the Solana connection
const mockGetSignaturesForAddress = jest.fn();
const mockGetParsedTransaction = jest.fn();

jest.mock("../solana/connection", () => ({
  getConnection: () => ({
    getSignaturesForAddress: mockGetSignaturesForAddress,
    getParsedTransaction: mockGetParsedTransaction,
  }),
}));

import { PoolWatcher } from "../watcher/poolwatcher";

describe("PoolWatcher", () => {
  let watcher: PoolWatcher;

  beforeEach(() => {
    jest.clearAllMocks();
    watcher = new PoolWatcher();
  });

  afterEach(() => {
    watcher.stop();
  });

  it("should register callback via onNewPool", () => {
    const cb = jest.fn();
    watcher.onNewPool(cb);
    // Internal state: callback is set (no public getter, just verify no throw)
    expect(() => watcher.onNewPool(cb)).not.toThrow();
  });

  it("should start and stop without errors", async () => {
    mockGetSignaturesForAddress.mockResolvedValue([
      { signature: "baseline_sig_123" },
    ]);

    watcher.start();

    // Wait for baseline initialization
    await new Promise((r) => setTimeout(r, 100));

    watcher.stop();

    // Should have called getSignaturesForAddress for baseline
    expect(mockGetSignaturesForAddress).toHaveBeenCalled();
  });

  it("should not start twice", () => {
    mockGetSignaturesForAddress.mockResolvedValue([]);

    watcher.start();
    watcher.start(); // second call should be a no-op

    watcher.stop();
  });

  it("should handle empty signatures on baseline", async () => {
    mockGetSignaturesForAddress.mockResolvedValue([]);

    watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    // Should not throw, just no baseline set
    expect(mockGetSignaturesForAddress).toHaveBeenCalled();
  });

  it("should handle baseline error gracefully", async () => {
    mockGetSignaturesForAddress.mockRejectedValue(new Error("RPC error"));

    watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    // Should not throw, error is caught internally
  });
});
