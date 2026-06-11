import * as path from "path";
import * as os from "os";
import * as fs from "fs";

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createDlmmBuyWallStore, DlmmBuyWallStore, WallRecord } from "../dlmm-buywall/store";
import { WallMonitor, StoredWall } from "../dlmm-buywall/monitor";

// recordSeen() stamps firstSeenAt with the real current time, so the
// monitor cycles must be driven with offsets from the real clock.
const NOW = new Date();

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
    totalYAmount: 100,
    lowerBinId: -100,
    upperBinId: -50,
    activeBinId: 0,
    binStep: 100,
    currentPrice: 100,
    rangeMinPrice: 80,
    rangeMaxPrice: 95,
    solIsTokenY: true,
    solValue: 100,
    solFraction: 1,
    binCount: 51,
    solPerBin: 100 / 51,
    rangeOrientation: "below",
    detectedAt: NOW.toISOString(),
    txSignature: "sig1",
    matchedReason: "test wall",
    ...over,
  };
}

describe("WallMonitor", () => {
  let tmpFile: string;
  let store: DlmmBuyWallStore;
  let removed: Array<{ wall: StoredWall; lastSol: number }>;
  let confirmed: Array<{ wall: StoredWall; sol: number }>;

  function makeMonitor(checker: (w: StoredWall) => Promise<number | null>): WallMonitor {
    return new WallMonitor(
      store,
      checker,
      {
        onRemoved: async (wall, lastSol) => {
          removed.push({ wall, lastSol });
        },
        onConfirmed: async (wall, sol) => {
          confirmed.push({ wall, sol });
        },
      },
      { delayBetweenChecksMs: 0, confirmAfterMs: 60 * 60_000 }
    );
  }

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `monitor-test-${Date.now()}-${Math.random()}.json`);
    store = createDlmmBuyWallStore(tmpFile);
    removed = [];
    confirmed = [];
  });

  afterEach(() => {
    store.flush();
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it("marks wall removed and alerts when position is gone", async () => {
    store.recordWall(makeWall());
    const monitor = makeMonitor(async () => null);
    await monitor.runCycle(NOW);

    expect(removed).toHaveLength(1);
    expect(removed[0].lastSol).toBe(0);
    expect(store.getWalls()[0].status).toBe("removed");
  });

  it("marks wall removed when drained below 25% of original size", async () => {
    store.recordWall(makeWall({ solValue: 100 }));
    const monitor = makeMonitor(async () => 20);
    await monitor.runCycle(NOW);

    expect(removed).toHaveLength(1);
    expect(removed[0].lastSol).toBe(20);
    expect(store.getWalls()[0].status).toBe("removed");
  });

  it("keeps wall active when partially reduced but above threshold", async () => {
    store.recordWall(makeWall({ solValue: 100 }));
    const monitor = makeMonitor(async () => 60);
    await monitor.runCycle(NOW);

    expect(removed).toHaveLength(0);
    expect(confirmed).toHaveLength(0);
    const wall = store.getWalls()[0];
    expect(wall.status).toBeUndefined();
    expect(wall.currentSolValue).toBe(60);
    expect(wall.lastCheckedAt).toBe(NOW.toISOString());
  });

  it("confirms wall still standing after the confirmation window", async () => {
    store.recordWall(makeWall({ solValue: 100 }));
    const monitor = makeMonitor(async () => 95);
    const later = new Date(NOW.getTime() + 90 * 60_000);
    await monitor.runCycle(later);

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].sol).toBe(95);
    expect(store.getWalls()[0].status).toBe("confirmed");
  });

  it("does not confirm a wall that is too young", async () => {
    store.recordWall(makeWall({ solValue: 100 }));
    const monitor = makeMonitor(async () => 95);
    const soon = new Date(NOW.getTime() + 10 * 60_000);
    await monitor.runCycle(soon);

    expect(confirmed).toHaveLength(0);
    expect(store.getWalls()[0].status).toBeUndefined();
  });

  it("does not re-check removed walls (no duplicate alerts)", async () => {
    store.recordWall(makeWall());
    const checker = jest.fn(async () => null);
    const monitor = makeMonitor(checker);
    await monitor.runCycle(NOW);
    await monitor.runCycle(new Date(NOW.getTime() + 5 * 60_000));

    expect(checker).toHaveBeenCalledTimes(1);
    expect(removed).toHaveLength(1);
  });

  it("does not re-confirm an already confirmed wall", async () => {
    store.recordWall(makeWall({ solValue: 100 }));
    const monitor = makeMonitor(async () => 95);
    const later = new Date(NOW.getTime() + 90 * 60_000);
    await monitor.runCycle(later);
    await monitor.runCycle(new Date(later.getTime() + 5 * 60_000));

    expect(confirmed).toHaveLength(1);
  });

  it("a confirmed wall can still be removed later", async () => {
    store.recordWall(makeWall({ solValue: 100 }));
    let sol: number | null = 95;
    const monitor = makeMonitor(async () => sol);
    await monitor.runCycle(new Date(NOW.getTime() + 90 * 60_000));
    expect(confirmed).toHaveLength(1);

    sol = null;
    await monitor.runCycle(new Date(NOW.getTime() + 120 * 60_000));
    expect(removed).toHaveLength(1);
    expect(store.getWalls()[0].status).toBe("removed");
  });

  it("keeps wall active when the checker throws (RPC hiccup)", async () => {
    store.recordWall(makeWall());
    const monitor = makeMonitor(async () => {
      throw new Error("RPC timeout");
    });
    await monitor.runCycle(NOW);

    expect(removed).toHaveLength(0);
    expect(store.getWalls()[0].status).toBeUndefined();
  });

  it("ignores walls older than maxAge", async () => {
    store.recordWall(makeWall());
    const checker = jest.fn(async () => 100);
    const monitor = makeMonitor(checker);
    const muchLater = new Date(NOW.getTime() + 25 * 3600_000);
    await monitor.runCycle(muchLater);

    expect(checker).not.toHaveBeenCalled();
  });
});
