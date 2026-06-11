import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createDlmmBuyWallStore, DlmmBuyWallStore } from "../dlmm-buywall/store";

describe("DlmmBuyWallStore", () => {
  let store: DlmmBuyWallStore;
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `dlmm-buywalls-${Date.now()}-${Math.random()}.json`);
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    store = createDlmmBuyWallStore(tmpFile);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it("hasSeen returns false for new address", () => {
    expect(store.hasSeen("p1")).toBe(false);
  });

  it("round-trip: recordSeen then hasSeen", () => {
    store.recordSeen("p1", { sol: 75 });
    expect(store.hasSeen("p1")).toBe(true);
  });

  it("persists and reloads from disk", () => {
    store.recordSeen("p1", { sol: 75 });
    const s2 = createDlmmBuyWallStore(tmpFile);
    expect(s2.hasSeen("p1")).toBe(true);
  });

  it("tracks size correctly", () => {
    expect(store.size()).toBe(0);
    store.recordSeen("a", {});
    store.recordSeen("b", {});
    expect(store.size()).toBe(2);
  });

  it("recordSeen is idempotent", () => {
    store.recordSeen("p1", { sol: 75 });
    store.recordSeen("p1", { sol: 80 });
    expect(store.size()).toBe(1);
  });
});
