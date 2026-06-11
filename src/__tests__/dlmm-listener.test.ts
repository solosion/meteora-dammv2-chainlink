jest.mock("../dlmm-buywall/analyzer", () => ({
  analyzeDlmmPosition: jest.fn(),
}));

jest.mock("../solana/connection", () => ({
  getConnection: () => ({
    onLogs: jest.fn(),
    removeOnLogsListener: jest.fn(),
  }),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { isDlmmPositionEventLogBatch } from "../listener/dlmm-position-listener";

describe("isDlmmPositionEventLogBatch", () => {
  it("matches InitializePosition", () => {
    expect(isDlmmPositionEventLogBatch(["Program log: Instruction: InitializePosition"])).toBe(true);
  });

  it("matches AddLiquidityByStrategyOneSide", () => {
    expect(isDlmmPositionEventLogBatch(["Program log: Instruction: AddLiquidityByStrategyOneSide"])).toBe(true);
  });

  it("matches InitializePositionByOperator", () => {
    expect(isDlmmPositionEventLogBatch(["Program log: Instruction: InitializePositionByOperator"])).toBe(true);
  });

  it("matches AddLiquidity2", () => {
    expect(isDlmmPositionEventLogBatch(["Program log: Instruction: AddLiquidity2"])).toBe(true);
  });

  it("does not match Swap", () => {
    expect(isDlmmPositionEventLogBatch(["Program log: Instruction: Swap"])).toBe(false);
  });

  it("does not match RemoveLiquidity", () => {
    expect(isDlmmPositionEventLogBatch(["Program log: Instruction: RemoveLiquidity"])).toBe(false);
  });

  it("matches when relevant log is among other logs", () => {
    expect(isDlmmPositionEventLogBatch([
      "Program log: Instruction: Swap",
      "Program log: some other stuff",
      "Program log: Instruction: AddLiquidityByStrategy",
    ])).toBe(true);
  });

  it("does not match empty logs", () => {
    expect(isDlmmPositionEventLogBatch([])).toBe(false);
  });
});
