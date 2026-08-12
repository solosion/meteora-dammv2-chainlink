import { describe, it, expect, vi } from "vitest";

// Prevent @meteora-ag/dlmm ESM resolution errors by mocking the analyzer at module boundary
vi.mock("../src/dlmm-buywall/analyzer", () => ({
  analyzeDlmmPosition: vi.fn(),
}));

import { isDlmmPositionEventLogBatch } from "../src/listener/dlmm-position-listener";

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
  it("does not match Swap", () => {
    expect(isDlmmPositionEventLogBatch(["Program log: Instruction: Swap"])).toBe(false);
  });
  it("does not match RemoveLiquidity", () => {
    expect(isDlmmPositionEventLogBatch(["Program log: Instruction: RemoveLiquidity"])).toBe(false);
  });
});
