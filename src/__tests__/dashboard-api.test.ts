import * as path from "path";
import * as os from "os";
import * as fs from "fs";

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { buildApiResponse, ActivityEntry, DashboardDeps } from "../dashboard/server";
import { createDlmmBuyWallStore, WallRecord } from "../dlmm-buywall/store";

function makeWall(over: Partial<WallRecord> = {}): WallRecord {
  return {
    positionAddress: "pos1",
    lbPairAddress: "lb1",
    owner: "owner1",
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
    currentPrice: 100,
    rangeMinPrice: 80,
    rangeMaxPrice: 95,
    solIsTokenY: true,
    solValue: 75,
    solFraction: 1,
    rangeOrientation: "below",
    detectedAt: new Date().toISOString(),
    txSignature: "sig1",
    matchedReason: "test wall",
    tokenSymbol: "TEST",
    marketCapUsd: 500_000,
    ...over,
  };
}

describe("dashboard API", () => {
  let tmpFile: string;
  let deps: DashboardDeps;
  const activity: ActivityEntry[] = [
    {
      at: new Date().toISOString(),
      positionAddress: "pos1",
      lbPairAddress: "lb1",
      solValue: 75,
      matched: true,
      reason: "test",
    },
  ];

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `dash-test-${Date.now()}-${Math.random()}.json`);
    const store = createDlmmBuyWallStore(tmpFile);
    store.recordWall(makeWall());
    deps = {
      store,
      getListenerStatus: () => ({
        active: true,
        lastEventAgeSec: 5,
        reconnectAttempts: 0,
        startedAt: new Date().toISOString(),
        counters: { logBatchesMatched: 10, txAnalyzed: 8, snapshotsProduced: 3 },
      }),
      getActivity: () => activity,
      config: { enabled: true, minSol: 50, direction: "below", singleSideThreshold: 0.95 },
      authToken: "",
    };
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it("/api/walls returns walls with computed metrics", () => {
    const res = buildApiResponse(deps, "/api/walls")!;
    expect(res.status).toBe(200);
    const body = res.body as { walls: Array<WallRecord & { metrics: { distancePct: number } }> };
    expect(body.walls).toHaveLength(1);
    expect(body.walls[0].tokenSymbol).toBe("TEST");
    expect(body.walls[0].metrics.distancePct).toBeCloseTo(5);
  });

  it("/api/stats returns aggregated stats", () => {
    const res = buildApiResponse(deps, "/api/stats")!;
    expect(res.status).toBe(200);
    const body = res.body as { last24h: { count: number }; hourly: unknown[] };
    expect(body.last24h.count).toBe(1);
    expect(body.hourly).toHaveLength(24);
  });

  it("/api/status returns listener status and config", () => {
    const res = buildApiResponse(deps, "/api/status")!;
    expect(res.status).toBe(200);
    const body = res.body as {
      enabled: boolean;
      listener: { active: boolean };
      config: { minSol: number };
      totalWalls: number;
    };
    expect(body.enabled).toBe(true);
    expect(body.listener.active).toBe(true);
    expect(body.config.minSol).toBe(50);
    expect(body.totalWalls).toBe(1);
  });

  it("/api/activity returns the activity feed", () => {
    const res = buildApiResponse(deps, "/api/activity")!;
    expect(res.status).toBe(200);
    const body = res.body as { activity: ActivityEntry[] };
    expect(body.activity).toHaveLength(1);
    expect(body.activity[0].matched).toBe(true);
  });

  it("returns null for unknown paths", () => {
    expect(buildApiResponse(deps, "/api/nope")).toBeNull();
  });
});

describe("store getWalls", () => {
  it("returns full wall records, newest first", () => {
    const tmpFile = path.join(os.tmpdir(), `store-test-${Date.now()}-${Math.random()}.json`);
    const store = createDlmmBuyWallStore(tmpFile);
    store.recordWall(makeWall({ positionAddress: "a", solValue: 60 }));
    store.recordWall(makeWall({ positionAddress: "b", solValue: 90 }));
    const walls = store.getWalls();
    expect(walls).toHaveLength(2);
    expect(walls.map((w) => w.positionAddress).sort()).toEqual(["a", "b"]);
    fs.unlinkSync(tmpFile);
  });

  it("maps legacy minimal entries (lbPair/sol/reason) defensively", () => {
    const tmpFile = path.join(os.tmpdir(), `store-legacy-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        seen: [
          {
            positionAddress: "legacy1",
            firstSeenAt: "2026-06-01T00:00:00.000Z",
            meta: { lbPair: "lbLegacy", sol: 123, reason: "old format" },
          },
        ],
      })
    );
    const store = createDlmmBuyWallStore(tmpFile);
    const walls = store.getWalls();
    expect(walls).toHaveLength(1);
    expect(walls[0].solValue).toBe(123);
    expect(walls[0].lbPairAddress).toBe("lbLegacy");
    expect(walls[0].matchedReason).toBe("old format");
    fs.unlinkSync(tmpFile);
  });

  it("persists enrichment fields across reload", () => {
    const tmpFile = path.join(os.tmpdir(), `store-persist-${Date.now()}-${Math.random()}.json`);
    const store = createDlmmBuyWallStore(tmpFile);
    store.recordWall(makeWall({ tokenSymbol: "PERSIST", marketCapUsd: 42 }));
    const store2 = createDlmmBuyWallStore(tmpFile);
    const walls = store2.getWalls();
    expect(walls[0].tokenSymbol).toBe("PERSIST");
    expect(walls[0].marketCapUsd).toBe(42);
    fs.unlinkSync(tmpFile);
  });
});
