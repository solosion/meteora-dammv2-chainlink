import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createDlmmBuyWallStore, DlmmBuyWallStore } from "../src/dlmm-buywall/store";

describe("DlmmBuyWallStore", () => {
  let store: DlmmBuyWallStore;
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `dlmm-buywalls-${Date.now()}-${Math.random()}.json`);
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    store = createDlmmBuyWallStore(tmpFile);
  });

  it("hasSeen false for new", () => {
    expect(store.hasSeen("p1")).toBe(false);
  });

  it("round-trip", () => {
    store.recordSeen("p1", { sol: 75 });
    expect(store.hasSeen("p1")).toBe(true);
  });

  it("persists and reloads", () => {
    store.recordSeen("p1", { sol: 75 });
    const s2 = createDlmmBuyWallStore(tmpFile);
    expect(s2.hasSeen("p1")).toBe(true);
  });

  it("size", () => {
    expect(store.size()).toBe(0);
    store.recordSeen("a", {});
    store.recordSeen("b", {});
    expect(store.size()).toBe(2);
  });

  it("idempotent", () => {
    store.recordSeen("p1", { sol: 75 });
    store.recordSeen("p1", { sol: 80 });
    expect(store.size()).toBe(1);
  });
});
