import fs from "fs";
import path from "path";
import {
  addPosition,
  getOpenPositions,
  getAllPositions,
  getOpenPositionCount,
  getTotalExposureSol,
  getTotalPnl,
  updatePositionValue,
  closeTrackedPosition,
  getPositionsSummary,
} from "../tracker/store";

// Mock logger
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const DATA_DIR = path.join(process.cwd(), "data");
const POSITIONS_FILE = path.join(DATA_DIR, "positions.json");

describe("Position Store", () => {
  // Clean up test data before/after each test
  beforeEach(() => {
    if (fs.existsSync(POSITIONS_FILE)) {
      fs.unlinkSync(POSITIONS_FILE);
    }
  });

  afterAll(() => {
    if (fs.existsSync(POSITIONS_FILE)) {
      fs.unlinkSync(POSITIONS_FILE);
    }
  });

  const samplePosition = {
    poolAddress: "PoolAddr111",
    positionAddress: "PosAddr222",
    positionNftMint: "NftMint333",
    tokenAMint: "TokenA444",
    tokenBMint: "So11111111111111111111111111111111111111112",
    tokenAAmount: "1000000",
    tokenBAmount: "500000",
    entryValueSol: 0.5,
    openedAt: new Date().toISOString(),
    txSignature: "TxSig555",
  };

  it("should add a position and retrieve it", () => {
    const tracked = addPosition(samplePosition);

    expect(tracked.id).toBeDefined();
    expect(tracked.id).toMatch(/^pos_/);
    expect(tracked.status).toBe("open");
    expect(tracked.poolAddress).toBe("PoolAddr111");
    expect(tracked.entryValueSol).toBe(0.5);

    const open = getOpenPositions();
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(tracked.id);
  });

  it("should count open positions correctly", () => {
    addPosition(samplePosition);
    addPosition({ ...samplePosition, poolAddress: "Pool2" });

    expect(getOpenPositionCount()).toBe(2);
  });

  it("should calculate total exposure", () => {
    addPosition({ ...samplePosition, entryValueSol: 0.5 });
    addPosition({ ...samplePosition, entryValueSol: 1.0, poolAddress: "Pool2" });

    expect(getTotalExposureSol()).toBeCloseTo(1.5);
  });

  it("should update position value and P&L", () => {
    const tracked = addPosition(samplePosition);

    updatePositionValue(tracked.id, 0.6, 0.1, 20);

    const positions = getOpenPositions();
    expect(positions[0].currentValueSol).toBeCloseTo(0.6);
    expect(positions[0].pnlSol).toBeCloseTo(0.1);
    expect(positions[0].pnlPercent).toBeCloseTo(20);
  });

  it("should close a position and track P&L", () => {
    const tracked = addPosition(samplePosition);

    closeTrackedPosition(tracked.id, "CloseTxSig", "manual-close", 0.15);

    const open = getOpenPositions();
    expect(open).toHaveLength(0);

    const all = getAllPositions();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("closed");
    expect(all[0].closeReason).toBe("manual-close");
    expect(all[0].finalPnlSol).toBeCloseTo(0.15);

    expect(getTotalPnl()).toBeCloseTo(0.15);
  });

  it("should return summary for empty positions", () => {
    const summary = getPositionsSummary();
    expect(summary).toContain("Keine offenen Positionen");
  });

  it("should return formatted summary with positions", () => {
    addPosition(samplePosition);
    const summary = getPositionsSummary();
    expect(summary).toContain("1 offene Position");
    expect(summary).toContain("0.5000 SOL");
  });
});
