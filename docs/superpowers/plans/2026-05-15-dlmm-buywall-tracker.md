# Meteora DLMM SOL Buy Wall Tracker — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute task-by-task.

**Goal:** Detect when someone opens a large single-sided SOL position on any Meteora DLMM pool (≥ 50 SOL) and send a Telegram alert. **Detection-only — no auto-trade, no Jupiter swap, no opening counter-positions.**

**Architecture:** A new `DlmmPositionListener` subscribes to the DLMM program (`LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`) and watches for position-creation + single-sided liquidity instructions. Each affected position is loaded via `DLMM.create(...)` + `getPositionsByUserAndLbPair`, then analyzed for SOL fraction, bin-range orientation vs `activeId`, and total SOL value. Filtered matches go to Telegram. Runs alongside the existing DAMM v2 pool tailer — completely independent, opt-in via `DLMM_BUYWALL_ENABLED`.

**Tech Stack:** TypeScript, `@meteora-ag/dlmm` (just installed, ^1.9.9), `@solana/web3.js` `connection.onLogs`, `telegraf`, `vitest`, `decimal.js`, `bn.js`.

## DLMM Facts Verified from SDK (do not re-verify)

From `node_modules/@meteora-ag/dlmm/dist/index.d.ts` + `index.js`:

- **Program ID:** `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` (constant: `LBCLMM_PROGRAM_IDS["mainnet-beta"]`)
- **PositionV2 struct fields:** `lbPair`, `owner`, `lowerBinId` (i32), `upperBinId` (i32), `liquidityShares[70]` (u128 array), `operator`, plus fee/reward bookkeeping. Position **does have an owner field** — read directly, no fee-payer derivation needed.
- **Position-creation instructions:** `initializePosition`, `initializePosition2`, `initializePositionByOperator`, `initializePositionPda`. Liquidity add: `addLiquidity`, `addLiquidity2`, `addLiquidityByStrategy`, `addLiquidityByStrategy2`, `addLiquidityByStrategyOneSide` (← the explicit single-sided variant).
- **Active bin:** `lbPair.activeId` (i32).
- **Bin price helper:** `getPriceOfBinByBinId(binId, binStep): Decimal` — exported by the SDK.
- **Static class entry:** `DLMM.create(connection, lbPairPubkey, opt)` → instance with `getPositionsByUserAndLbPair`, `getActiveBin`, `lbPair.binStep`, etc.
- **Position data shape (from `getPositionsByUserAndLbPair`):** `userPositions[].positionData` has `totalXAmount: string`, `totalYAmount: string`, `lowerBinId: number`, `upperBinId: number`, `owner: PublicKey`, `positionBinData: PositionBinData[]`.

## Direction semantics (default)

In DLMM `LbPair`, token X is base, token Y is quote. For SOL-paired pools, SOL is typically **token Y** (quote). Bin price increases with `binId` (more Y per X).

- Bins **below** `activeId` hold **token Y** (SOL) → these are **buy walls** for the token (SOL waiting to buy X if price drops).
- Bins **above** `activeId` hold **token X** (the meme/alt token) → these are **sell walls**.

So a "SOL buy wall" = single-sided SOL position with `upperBinId < activeId` AND SOL is token Y. **Default `DLMM_BUYWALL_DIRECTION=below`** with this semantic. Configurable to `above`/`either` if the user means something different.

If SOL is token X in a given pool (rare but possible), the mapping flips — the analyzer handles both cases.

## File Structure

**New files:**
- `src/dlmm-buywall/types.ts` — `DlmmPositionSnapshot`, `DetectedDlmmBuyWall`, `DlmmBuyWallFilterConfig`, `DlmmBuyWallDirection`.
- `src/dlmm-buywall/filter.ts` — pure `isDlmmBuyWall(snapshot, config)` predicate.
- `src/dlmm-buywall/store.ts` — JSON dedup of seen positions (`data/dlmm-buywalls.json`).
- `src/dlmm-buywall/analyzer.ts` — fetches state via DLMM SDK, computes snapshot.
- `src/dlmm-buywall/notifier.ts` — Telegram HTML formatter.
- `src/listener/dlmm-position-listener.ts` — `onLogs` subscriber + log-marker predicate + per-TX dispatcher.
- Tests in `tests/dlmm-*.test.ts`.

**Modified files:**
- `src/config.ts` — add `dlmmBuywall` config section.
- `src/index.ts` — instantiate listener + register `handleDlmmBuyWall` callback + `/dlmm_buywalls` command + shutdown hook. **No Jupiter/swap/openPosition code paths.**
- `.env.example` — document the new env vars.

## Lessons applied from DAMM v2 attempt

1. **Use SDK helpers — never reimplement math.** Use `getPriceOfBinByBinId`, `DLMM.create`, `getPositionsByUserAndLbPair`. No homegrown Q64.64.
2. **Verify IDL fields before writing tests.** Already done (see DLMM Facts section above).
3. **Magnitude tests, not just sign tests.** Each analyzer/math test asserts a specific SOL amount within ±10% tolerance using realistic inputs.
4. **Read `position.owner` directly** — DLMM exposes it, unlike DAMM v2.
5. **TOCTOU-safe dedup:** `recordSeen` immediately after `hasSeen` check, before any async work.
6. **Watch BOTH position-create AND single-sided add-liquidity instructions** — the wall might be added after the position was created in a separate TX.
7. **Detection-only path.** No wallet operations, no Jupiter, no openPosition.

---

## Task 1: Add DLMM buywall config

**Files:**
- Modify: `src/config.ts` (append new section)
- Test: `tests/dlmm-buywall-config.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// tests/dlmm-buywall-config.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("dlmmBuywall config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.SOLANA_RPC_URL = "https://example";
    process.env.SOLANA_SEED_PHRASE = "test test test test test test test test test test test junk";
    process.env.TELEGRAM_BOT_TOKEN = "x";
    process.env.TELEGRAM_ADMIN_CHAT_ID = "1";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("defaults: disabled, 50 SOL threshold, below direction, 0.95 single-side", async () => {
    delete process.env.DLMM_BUYWALL_ENABLED;
    delete process.env.DLMM_BUYWALL_MIN_SOL;
    delete process.env.DLMM_BUYWALL_DIRECTION;
    delete process.env.DLMM_BUYWALL_SINGLE_SIDE_THRESHOLD;
    vi.resetModules();
    const { config } = await import("../src/config");
    expect(config.dlmmBuywall.enabled).toBe(false);
    expect(config.dlmmBuywall.minSol).toBe(50);
    expect(config.dlmmBuywall.direction).toBe("below");
    expect(config.dlmmBuywall.singleSideThreshold).toBe(0.95);
  });

  it("reads overrides", async () => {
    process.env.DLMM_BUYWALL_ENABLED = "true";
    process.env.DLMM_BUYWALL_MIN_SOL = "100";
    process.env.DLMM_BUYWALL_DIRECTION = "either";
    process.env.DLMM_BUYWALL_SINGLE_SIDE_THRESHOLD = "0.8";
    vi.resetModules();
    const { config } = await import("../src/config");
    expect(config.dlmmBuywall.enabled).toBe(true);
    expect(config.dlmmBuywall.minSol).toBe(100);
    expect(config.dlmmBuywall.direction).toBe("either");
    expect(config.dlmmBuywall.singleSideThreshold).toBe(0.8);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```
cd /Users/raphael/meteora-dammv2-chainlink && npx vitest run tests/dlmm-buywall-config.test.ts
```

- [ ] **Step 3: Append to `src/config.ts` before the closing `};` of `export const config`:**

```typescript
  dlmmBuywall: {
    enabled: optional("DLMM_BUYWALL_ENABLED", "false").toLowerCase() === "true",
    minSol: parseFloat(optional("DLMM_BUYWALL_MIN_SOL", "50")),
    direction: (optional("DLMM_BUYWALL_DIRECTION", "below").toLowerCase() as
      | "above"
      | "below"
      | "either"),
    singleSideThreshold: parseFloat(
      optional("DLMM_BUYWALL_SINGLE_SIDE_THRESHOLD", "0.95")
    ),
  },
```

- [ ] **Step 4: Run, expect 2 PASS**

- [ ] **Step 5: Commit**

```bash
cd /Users/raphael/meteora-dammv2-chainlink
git add src/config.ts tests/dlmm-buywall-config.test.ts
git commit -m "feat(dlmm-buywall): config (enabled, minSol, direction default below, threshold)"
```

---

## Task 2: Shared types

**Files:** Create `src/dlmm-buywall/types.ts`

- [ ] **Step 1: Write the file**

```typescript
// src/dlmm-buywall/types.ts
export type DlmmBuyWallDirection = "above" | "below" | "either";

/** Snapshot of a DLMM position at detection time. */
export interface DlmmPositionSnapshot {
  positionAddress: string;
  lbPairAddress: string;
  owner: string;
  /** Mint of token X (base). */
  tokenXMint: string;
  /** Mint of token Y (quote). */
  tokenYMint: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
  /** UI-unit amounts. */
  totalXAmount: number;
  totalYAmount: number;
  lowerBinId: number;
  upperBinId: number;
  /** Pool's current active bin. */
  activeBinId: number;
  binStep: number;
  /** Current price (Y per X) as decimal-shifted UI units. */
  currentPrice: number;
  rangeMinPrice: number;
  rangeMaxPrice: number;
  /** True if SOL is token Y; false if SOL is token X. */
  solIsTokenY: boolean;
  /** SOL value of the entire position (UI SOL units). */
  solValue: number;
  /** Fraction of position value held in SOL ∈ [0,1]. */
  solFraction: number;
  rangeOrientation: "above" | "below" | "across";
  detectedAt: string;
  txSignature: string;
}

export interface DetectedDlmmBuyWall extends DlmmPositionSnapshot {
  matchedReason: string;
}

export interface DlmmBuyWallFilterConfig {
  minSol: number;
  direction: DlmmBuyWallDirection;
  singleSideThreshold: number;
}

export type DlmmBuyWallCallback = (
  wall: DetectedDlmmBuyWall
) => Promise<void>;
```

- [ ] **Step 2: `npx tsc --noEmit` — clean**

- [ ] **Step 3: Commit**

```bash
git add src/dlmm-buywall/types.ts
git commit -m "feat(dlmm-buywall): shared types"
```

---

## Task 3: Pure filter

**Files:**
- Create: `src/dlmm-buywall/filter.ts`
- Test: `tests/dlmm-buywall-filter.test.ts`

- [ ] **Step 1: Test**

```typescript
// tests/dlmm-buywall-filter.test.ts
import { describe, it, expect } from "vitest";
import { isDlmmBuyWall } from "../src/dlmm-buywall/filter";
import { DlmmPositionSnapshot } from "../src/dlmm-buywall/types";

function snap(over: Partial<DlmmPositionSnapshot> = {}): DlmmPositionSnapshot {
  return {
    positionAddress: "p1",
    lbPairAddress: "lb1",
    owner: "o1",
    tokenXMint: "X11111111111111111111111111111111",
    tokenYMint: "So11111111111111111111111111111111111111112",
    tokenXDecimals: 6,
    tokenYDecimals: 9,
    totalXAmount: 0,
    totalYAmount: 75,
    lowerBinId: -100,
    upperBinId: -50,
    activeBinId: 0,
    binStep: 100,
    currentPrice: 1,
    rangeMinPrice: 0.5,
    rangeMaxPrice: 0.7,
    solIsTokenY: true,
    solValue: 75,
    solFraction: 1.0,
    rangeOrientation: "below",
    detectedAt: "2026-05-15T00:00:00.000Z",
    txSignature: "sig1",
    ...over,
  };
}

const cfg = { minSol: 50, direction: "below" as const, singleSideThreshold: 0.95 };

describe("isDlmmBuyWall", () => {
  it("accepts 100% SOL, 75 SOL, range below current (the classic buy wall)", () => {
    expect(isDlmmBuyWall(snap(), cfg).matched).toBe(true);
  });

  it("rejects when below SOL threshold", () => {
    const r = isDlmmBuyWall(snap({ solValue: 30, totalYAmount: 30 }), cfg);
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/min_sol/i);
  });

  it("rejects when not single-sided enough", () => {
    const r = isDlmmBuyWall(snap({ solFraction: 0.5, totalXAmount: 100 }), cfg);
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/single_side/i);
  });

  it("rejects when range orientation is across", () => {
    expect(isDlmmBuyWall(snap({ rangeOrientation: "across" }), cfg).matched).toBe(false);
  });

  it("rejects when direction mismatched", () => {
    const r = isDlmmBuyWall(snap({ rangeOrientation: "above" }), cfg);
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/direction/i);
  });

  it("either accepts both", () => {
    expect(isDlmmBuyWall(snap({ rangeOrientation: "above" }), { ...cfg, direction: "either" }).matched).toBe(true);
    expect(isDlmmBuyWall(snap({ rangeOrientation: "below" }), { ...cfg, direction: "either" }).matched).toBe(true);
  });

  it("rejects when neither token is SOL", () => {
    const r = isDlmmBuyWall(
      snap({
        tokenYMint: "Other111111111111111111111111111111111111",
        solIsTokenY: false,
        solValue: 0,
        solFraction: 0,
      }),
      cfg
    );
    expect(r.matched).toBe(false);
  });
});
```

- [ ] **Step 2: `npx vitest run tests/dlmm-buywall-filter.test.ts` — expect FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/dlmm-buywall/filter.ts
import { DlmmPositionSnapshot, DlmmBuyWallFilterConfig } from "./types";

export interface DlmmFilterResult {
  matched: boolean;
  reason: string;
}

export function isDlmmBuyWall(
  snapshot: DlmmPositionSnapshot,
  config: DlmmBuyWallFilterConfig
): DlmmFilterResult {
  if (snapshot.solValue < config.minSol) {
    return { matched: false, reason: `min_sol: ${snapshot.solValue.toFixed(2)} < ${config.minSol}` };
  }
  if (snapshot.solFraction < config.singleSideThreshold) {
    return {
      matched: false,
      reason: `single_side: ${(snapshot.solFraction * 100).toFixed(1)}% < ${(config.singleSideThreshold * 100).toFixed(1)}%`,
    };
  }
  if (snapshot.rangeOrientation === "across") {
    return { matched: false, reason: "across: bin range straddles active bin" };
  }
  if (config.direction !== "either" && snapshot.rangeOrientation !== config.direction) {
    return {
      matched: false,
      reason: `direction: range is ${snapshot.rangeOrientation}, want ${config.direction}`,
    };
  }
  return {
    matched: true,
    reason: `${snapshot.solValue.toFixed(2)} SOL, ${(snapshot.solFraction * 100).toFixed(1)}% single-sided, range ${snapshot.rangeOrientation}`,
  };
}
```

- [ ] **Step 4: 7 tests PASS**
- [ ] **Step 5: Commit**

```bash
git add src/dlmm-buywall/filter.ts tests/dlmm-buywall-filter.test.ts
git commit -m "feat(dlmm-buywall): pure filter predicate"
```

---

## Task 4: Dedup store

**Files:**
- Create: `src/dlmm-buywall/store.ts`
- Test: `tests/dlmm-buywall-store.test.ts`

Same shape as the DAMM v2 store (look at `git show feature/sol-buywall-tracker:src/buywall/store.ts` if needed for reference, but write a fresh one — types named `DlmmBuyWallStore`, `createDlmmBuyWallStore`).

- [ ] **Step 1: Tests (5 tests: hasSeen new, round-trip, persist+reload, size, idempotent)**

```typescript
// tests/dlmm-buywall-store.test.ts
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
```

- [ ] **Step 2: Implement**

```typescript
// src/dlmm-buywall/store.ts
import * as fs from "fs";
import * as path from "path";

export interface DlmmBuyWallStore {
  hasSeen(positionAddress: string): boolean;
  recordSeen(positionAddress: string, meta: Record<string, unknown>): void;
  size(): number;
}

interface SeenEntry {
  positionAddress: string;
  firstSeenAt: string;
  meta: Record<string, unknown>;
}

interface FileContents {
  seen: SeenEntry[];
}

export function createDlmmBuyWallStore(filePath: string): DlmmBuyWallStore {
  const seen = new Map<string, SeenEntry>();
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as FileContents;
      for (const entry of parsed.seen ?? []) seen.set(entry.positionAddress, entry);
    } catch {
      // corrupt — start fresh
    }
  }
  function persist(): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ seen: Array.from(seen.values()) }, null, 2));
  }
  return {
    hasSeen: (a) => seen.has(a),
    recordSeen: (a, m) => {
      if (seen.has(a)) return;
      seen.set(a, { positionAddress: a, firstSeenAt: new Date().toISOString(), meta: m });
      persist();
    },
    size: () => seen.size,
  };
}
```

- [ ] **Step 3: PASS** — [ ] **Step 4: Commit**

```bash
git add src/dlmm-buywall/store.ts tests/dlmm-buywall-store.test.ts
git commit -m "feat(dlmm-buywall): JSON dedup store"
```

---

## Task 5: Analyzer (DLMM SDK)

**Files:**
- Create: `src/dlmm-buywall/analyzer.ts`
- Test: `tests/dlmm-buywall-analyzer.test.ts` (mocked SDK)

The analyzer:
1. Takes a position address + tx signature
2. Creates `DLMM.create(connection, lbPairPubkey)` for the position's pool (we need the lbPair from somewhere — Task 7's listener passes it in after parsing the TX OR after fetching position state)
3. Fetches the position via `getPositionsByUserAndLbPair(owner)` and finds the matching one
4. Reads `positionData.totalXAmount`, `totalYAmount`, `lowerBinId`, `upperBinId`, `owner`
5. Reads `lbPair.activeId` + `lbPair.binStep` + `lbPair.tokenXMint` + `lbPair.tokenYMint`
6. Fetches mint decimals via `connection.getParsedAccountInfo` (helper utility)
7. Computes prices: `getPriceOfBinByBinId(binId, binStep).toNumber() * 10^(decimalsX - decimalsY)`
8. Computes range orientation: `activeId vs [lowerBinId, upperBinId]`
9. Computes SOL value + fraction:
   - If SOL is tokenY: `solValue = totalYAmount + totalXAmount * currentPrice; solFraction = totalYAmount / solValue`
   - If SOL is tokenX: `solValue = totalXAmount + totalYAmount / currentPrice; solFraction = totalXAmount / solValue`

**Critical:** Use `DLMM.create` and its methods. Do NOT reimplement bin math.

- [ ] **Step 1: Write test with mocked DLMM SDK**

```typescript
// tests/dlmm-buywall-analyzer.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";

const mockGetPositionsByUserAndLbPair = vi.fn();
const mockGetParsedAccountInfo = vi.fn();
const mockGetPriceOfBinByBinId = vi.fn();
const mockDlmmCreate = vi.fn();

vi.mock("@meteora-ag/dlmm", () => ({
  default: {
    create: (...args: unknown[]) => mockDlmmCreate(...args),
  },
  getPriceOfBinByBinId: (...args: unknown[]) => mockGetPriceOfBinByBinId(...args),
}));

vi.mock("../src/solana/connection", () => ({
  getConnection: () => ({ getParsedAccountInfo: mockGetParsedAccountInfo }),
}));

const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_X = "Tokn11111111111111111111111111111111111111";

describe("analyzeDlmmPosition", () => {
  beforeEach(() => {
    mockGetPositionsByUserAndLbPair.mockReset();
    mockGetParsedAccountInfo.mockReset();
    mockGetPriceOfBinByBinId.mockReset();
    mockDlmmCreate.mockReset();
    mockGetParsedAccountInfo.mockImplementation(async (pk: PublicKey) => ({
      value: {
        data: { parsed: { info: { decimals: pk.toBase58() === SOL_MINT ? 9 : 6 } } },
      },
    }));
    // bin price helper — return a Decimal of (1.0001)^binId for simplicity in tests
    mockGetPriceOfBinByBinId.mockImplementation((binId: number) =>
      new Decimal(1.0001).pow(binId)
    );
  });

  it("classifies single-sided SOL buy wall below active bin (SOL=tokenY)", async () => {
    // active bin = 0, position spans bins -100..-50, all in token Y
    mockDlmmCreate.mockResolvedValue({
      lbPair: {
        activeId: 0,
        binStep: 100,
        tokenXMint: new PublicKey(TOKEN_X),
        tokenYMint: new PublicKey(SOL_MINT),
      },
      getPositionsByUserAndLbPair: mockGetPositionsByUserAndLbPair,
    });
    mockGetPositionsByUserAndLbPair.mockResolvedValue({
      activeBin: { binId: 0 },
      userPositions: [
        {
          publicKey: new PublicKey("Position11111111111111111111111111111111112"),
          positionData: {
            totalXAmount: "0",
            totalYAmount: (75 * 1e9).toString(), // 75 SOL in lamports
            lowerBinId: -100,
            upperBinId: -50,
            owner: new PublicKey("Owner1111111111111111111111111111111111112"),
          },
        },
      ],
    });

    const { analyzeDlmmPosition } = await import("../src/dlmm-buywall/analyzer");
    const result = await analyzeDlmmPosition(
      "Position11111111111111111111111111111111112",
      "lbPair11111111111111111111111111111111111111",
      "Owner1111111111111111111111111111111111112",
      "sig1"
    );

    expect(result).not.toBeNull();
    expect(result!.solIsTokenY).toBe(true);
    expect(result!.rangeOrientation).toBe("below");
    expect(result!.solValue).toBeGreaterThan(74);
    expect(result!.solValue).toBeLessThan(76);
    expect(result!.solFraction).toBeGreaterThan(0.95);
    expect(result!.owner).toBe("Owner1111111111111111111111111111111111112");
  });

  it("returns null when neither mint is SOL", async () => {
    mockDlmmCreate.mockResolvedValue({
      lbPair: {
        activeId: 0,
        binStep: 100,
        tokenXMint: new PublicKey(TOKEN_X),
        tokenYMint: new PublicKey("Other1111111111111111111111111111111111111"),
      },
      getPositionsByUserAndLbPair: mockGetPositionsByUserAndLbPair,
    });
    mockGetPositionsByUserAndLbPair.mockResolvedValue({
      userPositions: [{
        publicKey: new PublicKey("Position11111111111111111111111111111111112"),
        positionData: { totalXAmount: "0", totalYAmount: "0", lowerBinId: -1, upperBinId: 1, owner: new PublicKey("Owner1111111111111111111111111111111111112") },
      }],
    });
    const { analyzeDlmmPosition } = await import("../src/dlmm-buywall/analyzer");
    expect(
      await analyzeDlmmPosition(
        "Position11111111111111111111111111111111112",
        "lbPair11111111111111111111111111111111111111",
        "Owner1111111111111111111111111111111111112",
        "sig1"
      )
    ).toBeNull();
  });
});
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/dlmm-buywall/analyzer.ts
import { PublicKey } from "@solana/web3.js";
import DLMM, { getPriceOfBinByBinId } from "@meteora-ag/dlmm";
import { getConnection } from "../solana/connection";
import { logger } from "../utils/logger";
import { DlmmPositionSnapshot } from "./types";

const SOL_MINT = "So11111111111111111111111111111111111111112";

async function fetchDecimals(mint: PublicKey): Promise<number> {
  const connection = getConnection();
  const info = await connection.getParsedAccountInfo(mint);
  const decimals = (info as {
    value?: { data?: { parsed?: { info?: { decimals?: number } } } };
  }).value?.data?.parsed?.info?.decimals;
  if (typeof decimals !== "number") {
    throw new Error(`Could not read decimals for ${mint.toBase58()}`);
  }
  return decimals;
}

function classify(active: number, low: number, high: number): "above" | "below" | "across" {
  if (active < low) return "above";
  if (active > high) return "below";
  return "across";
}

export async function analyzeDlmmPosition(
  positionAddressStr: string,
  lbPairAddressStr: string,
  ownerStr: string,
  txSignature: string
): Promise<DlmmPositionSnapshot | null> {
  const connection = getConnection();
  const lbPairPubkey = new PublicKey(lbPairAddressStr);
  const ownerPubkey = new PublicKey(ownerStr);

  const dlmm = await DLMM.create(connection, lbPairPubkey);
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(ownerPubkey);
  const match = userPositions.find(
    (p) => p.publicKey.toBase58() === positionAddressStr
  );
  if (!match) {
    logger.debug("DLMM position not found for owner", { positionAddressStr, owner: ownerStr });
    return null;
  }

  const tokenXMint: PublicKey = dlmm.lbPair.tokenXMint;
  const tokenYMint: PublicKey = dlmm.lbPair.tokenYMint;
  const solIsTokenX = tokenXMint.toBase58() === SOL_MINT;
  const solIsTokenY = tokenYMint.toBase58() === SOL_MINT;
  if (!solIsTokenX && !solIsTokenY) {
    logger.debug("DLMM pool has no SOL side, skipping", { lbPair: lbPairAddressStr });
    return null;
  }

  const [decimalsX, decimalsY] = await Promise.all([
    fetchDecimals(tokenXMint),
    fetchDecimals(tokenYMint),
  ]);

  const binStep = dlmm.lbPair.binStep;
  const activeId = dlmm.lbPair.activeId;
  const { lowerBinId, upperBinId, totalXAmount, totalYAmount } = match.positionData;

  // Convert raw to UI amounts
  const totalXUi = Number(totalXAmount) / Math.pow(10, decimalsX);
  const totalYUi = Number(totalYAmount) / Math.pow(10, decimalsY);

  // Prices (decimal-adjusted: Y per X in UI units)
  const decimalAdj = Math.pow(10, decimalsX - decimalsY);
  const currentPrice = getPriceOfBinByBinId(activeId, binStep).toNumber() * decimalAdj;
  const rangeMinPrice = getPriceOfBinByBinId(lowerBinId, binStep).toNumber() * decimalAdj;
  const rangeMaxPrice = getPriceOfBinByBinId(upperBinId, binStep).toNumber() * decimalAdj;

  const rangeOrientation = classify(activeId, lowerBinId, upperBinId);

  // SOL value + fraction
  let solValue: number;
  let solFraction: number;
  if (solIsTokenY) {
    // price = Y per X, so X-value-in-SOL = totalX * currentPrice
    const xInSol = currentPrice > 0 ? totalXUi * currentPrice : 0;
    solValue = totalYUi + xInSol;
    solFraction = solValue > 0 ? totalYUi / solValue : 0;
  } else {
    // SOL is tokenX. Y-value-in-SOL = totalY / currentPrice
    const yInSol = currentPrice > 0 ? totalYUi / currentPrice : 0;
    solValue = totalXUi + yInSol;
    solFraction = solValue > 0 ? totalXUi / solValue : 0;
  }

  return {
    positionAddress: positionAddressStr,
    lbPairAddress: lbPairAddressStr,
    owner: match.positionData.owner.toBase58(),
    tokenXMint: tokenXMint.toBase58(),
    tokenYMint: tokenYMint.toBase58(),
    tokenXDecimals: decimalsX,
    tokenYDecimals: decimalsY,
    totalXAmount: totalXUi,
    totalYAmount: totalYUi,
    lowerBinId,
    upperBinId,
    activeBinId: activeId,
    binStep,
    currentPrice,
    rangeMinPrice,
    rangeMaxPrice,
    solIsTokenY,
    solValue,
    solFraction,
    rangeOrientation,
    detectedAt: new Date().toISOString(),
    txSignature,
  };
}
```

- [ ] **Step 4: 2 tests PASS**

- [ ] **Step 5: Commit**

```bash
git add src/dlmm-buywall/analyzer.ts tests/dlmm-buywall-analyzer.test.ts
git commit -m "feat(dlmm-buywall): analyzer using DLMM SDK"
```

---

## Task 6: Telegram notifier

**Files:**
- Create: `src/dlmm-buywall/notifier.ts`
- Test: `tests/dlmm-buywall-notifier.test.ts`

- [ ] **Step 1: Test**

```typescript
// tests/dlmm-buywall-notifier.test.ts
import { describe, it, expect } from "vitest";
import { formatDlmmBuyWallMessage } from "../src/dlmm-buywall/notifier";
import { DetectedDlmmBuyWall } from "../src/dlmm-buywall/types";

const wall: DetectedDlmmBuyWall = {
  positionAddress: "Pos1111111111111111111111111111111111111111",
  lbPairAddress: "LbPa11111111111111111111111111111111111111",
  owner: "Own1111111111111111111111111111111111111111",
  tokenXMint: "Tokn1111111111111111111111111111111111111",
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
  rangeOrientation: "below",
  detectedAt: "2026-05-15T00:00:00.000Z",
  txSignature: "Sig1111111111111111111111111111111111111111",
  matchedReason: "75.5 SOL, 100% single-sided, range below",
};

describe("formatDlmmBuyWallMessage", () => {
  it("includes key data fields", () => {
    const msg = formatDlmmBuyWallMessage(wall);
    expect(msg).toContain("75.5");
    expect(msg).toContain("Buy Wall");
    expect(msg).toContain("DLMM");
    expect(msg).toContain(wall.lbPairAddress.substring(0, 8));
    expect(msg).toContain(wall.owner.substring(0, 8));
    expect(msg).toContain(wall.txSignature.substring(0, 8));
    expect(msg).toContain("below");
    expect(msg).toContain("-100");
    expect(msg).toContain("-50");
  });

  it("uses HTML", () => {
    const msg = formatDlmmBuyWallMessage(wall);
    expect(msg).toMatch(/<b>/);
    expect(msg).toMatch(/<code>/);
  });
});
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/dlmm-buywall/notifier.ts
import { DetectedDlmmBuyWall } from "./types";

export function formatDlmmBuyWallMessage(wall: DetectedDlmmBuyWall): string {
  const tokenMint = wall.solIsTokenY ? wall.tokenXMint : wall.tokenYMint;
  const directionEmoji = wall.rangeOrientation === "above" ? "⬆️" : "⬇️";

  return (
    `🚧 <b>DLMM SOL Buy Wall Detected!</b> 🚧\n\n` +
    `💰 <b>Size:</b> ${wall.solValue.toFixed(2)} SOL ` +
    `(${(wall.solFraction * 100).toFixed(1)}% single-sided)\n` +
    `${directionEmoji} <b>Bins:</b> ${wall.lowerBinId} → ${wall.upperBinId} ` +
    `(${wall.rangeOrientation} active ${wall.activeBinId}, step ${wall.binStep})\n` +
    `   Current price: ${wall.currentPrice.toExponential(3)}\n` +
    `   Range price:   ${wall.rangeMinPrice.toExponential(3)} → ${wall.rangeMaxPrice.toExponential(3)}\n\n` +
    `🏊 <b>LbPair:</b> <code>${wall.lbPairAddress}</code>\n` +
    `🪙 <b>Token:</b> <code>${tokenMint}</code>\n` +
    `👤 <b>Owner:</b> <code>${wall.owner}</code>\n` +
    `📜 <b>Position:</b> <code>${wall.positionAddress}</code>\n` +
    `🔗 <b>TX:</b> <code>${wall.txSignature}</code>\n` +
    `\n<i>${wall.matchedReason}</i>`
  );
}
```

- [ ] **Step 4: PASS** — [ ] **Step 5: Commit**

```bash
git add src/dlmm-buywall/notifier.ts tests/dlmm-buywall-notifier.test.ts
git commit -m "feat(dlmm-buywall): Telegram notifier"
```

---

## Task 7: DLMM Position Listener

**Files:**
- Create: `src/listener/dlmm-position-listener.ts`
- Test: `tests/dlmm-position-listener.test.ts`

We watch the DLMM program for any of these instruction markers (verified from IDL):
```
"Program log: Instruction: InitializePosition"
"Program log: Instruction: InitializePosition2"
"Program log: Instruction: InitializePositionByOperator"
"Program log: Instruction: InitializePositionPda"
"Program log: Instruction: AddLiquidityByStrategy"
"Program log: Instruction: AddLiquidityByStrategy2"
"Program log: Instruction: AddLiquidityByStrategyOneSide"
"Program log: Instruction: AddLiquidity"
"Program log: Instruction: AddLiquidity2"
```

When a TX matches, fetch the parsed TX and find:
- All accounts owned by the DLMM program that are involved in this TX
- For each candidate, attempt to read it as a `PositionV2` account via the SDK
- Once we find the position address + its lbPair (from the position state) + its owner, call `analyzeDlmmPosition(...)`
- Emit each non-null snapshot to subscribers

- [ ] **Step 1: Test the log predicate**

```typescript
// tests/dlmm-position-listener.test.ts
import { describe, it, expect } from "vitest";
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
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement (model on pool-listener.ts for shape)**

```typescript
// src/listener/dlmm-position-listener.ts
import { PublicKey, Logs } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { getConnection } from "../solana/connection";
import { logger } from "../utils/logger";
import { analyzeDlmmPosition } from "../dlmm-buywall/analyzer";
import { DlmmPositionSnapshot } from "../dlmm-buywall/types";

const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

const EVENT_MARKERS = [
  "Program log: Instruction: InitializePosition",
  "Program log: Instruction: InitializePosition2",
  "Program log: Instruction: InitializePositionByOperator",
  "Program log: Instruction: InitializePositionPda",
  "Program log: Instruction: AddLiquidityByStrategy",
  "Program log: Instruction: AddLiquidityByStrategy2",
  "Program log: Instruction: AddLiquidityByStrategyOneSide",
  "Program log: Instruction: AddLiquidity",
  "Program log: Instruction: AddLiquidity2",
];

const DEDUP_CACHE_SIZE = 500;

export function isDlmmPositionEventLogBatch(logs: string[]): boolean {
  return logs.some((line) => EVENT_MARKERS.some((m) => line.includes(m)));
}

export type DlmmSnapshotCallback = (s: DlmmPositionSnapshot) => Promise<void>;

export class DlmmPositionListener {
  private subscriptionId: number | null = null;
  private callbacks: DlmmSnapshotCallback[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private lastLogTime = Date.now();
  private recentTxSigs = new Set<string>();
  private recentTxOrder: string[] = [];

  onPositionSnapshot(cb: DlmmSnapshotCallback): void {
    this.callbacks.push(cb);
  }

  start(): void {
    this.stopped = false;
    this.subscribe();
    this.startHeartbeat();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.subscriptionId !== null) {
      getConnection().removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
      logger.info("DLMM position listener stopped");
    }
  }

  private subscribe(): void {
    const connection = getConnection();
    logger.info("Subscribing to DLMM program logs");
    this.subscriptionId = connection.onLogs(
      DLMM_PROGRAM_ID,
      async (logs) => {
        this.lastLogTime = Date.now();
        try {
          await this.handleLogs(logs);
        } catch (err) {
          logger.error("DLMM-listener error", { error: String(err) });
        }
      },
      "confirmed"
    );
    this.reconnectAttempts = 0;
    this.lastLogTime = Date.now();
    logger.info("DLMM position listener active");
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const silence = Date.now() - this.lastLogTime;
      if (silence > 120_000 && !this.stopped) {
        logger.warn(`DLMM listener silent ${(silence / 1000).toFixed(0)}s, reconnecting`);
        this.reconnect();
      }
    }, 30_000);
  }

  private reconnect(): void {
    if (this.stopped) return;
    if (this.subscriptionId !== null) {
      try { getConnection().removeOnLogsListener(this.subscriptionId); } catch { /* ignore */ }
      this.subscriptionId = null;
    }
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30_000);
    this.reconnectTimer = setTimeout(() => this.subscribe(), delay);
  }

  private trackTxSig(sig: string): boolean {
    if (this.recentTxSigs.has(sig)) return false;
    this.recentTxSigs.add(sig);
    this.recentTxOrder.push(sig);
    if (this.recentTxOrder.length > DEDUP_CACHE_SIZE) {
      const oldest = this.recentTxOrder.shift()!;
      this.recentTxSigs.delete(oldest);
    }
    return true;
  }

  private async handleLogs(logs: Logs): Promise<void> {
    if (logs.err) return;
    if (!isDlmmPositionEventLogBatch(logs.logs)) return;
    if (!this.trackTxSig(logs.signature)) return;

    const connection = getConnection();
    const tx = await connection.getParsedTransaction(logs.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || !tx.meta) return;

    const accountKeys = tx.transaction.message.accountKeys;
    // The TX has the position account address. We don't know which one without parsing
    // the program's instruction discriminators. Easiest approach: for every account in
    // the TX owned by the DLMM program, try to load it as a position. If successful,
    // we have its lbPair + owner directly from the position state and can analyze.

    for (const ak of accountKeys) {
      const pubkey = ak.pubkey;
      try {
        const acctInfo = await connection.getAccountInfo(pubkey);
        if (!acctInfo) continue;
        if (!acctInfo.owner.equals(DLMM_PROGRAM_ID)) continue;
        // Try to decode as PositionV2 — owner field is at a known offset in the raw bytes,
        // but cleaner: use DLMM helper or anchor coder. We instead defer to DLMM.create
        // for the lbPair, then check getPositionsByUserAndLbPair. But we don't know the
        // lbPair yet. We'll need to peek at the position account's lbPair field directly
        // via the program coder OR attempt a decode and skip if it fails.

        // Try the Position-via-program approach: fetch the program account discriminator
        // and check it matches PositionV2 (first 8 bytes of the account data).
        // The PositionV2 discriminator is the sha256("account:PositionV2").slice(0, 8).
        // We hardcode it here to avoid a runtime IDL lookup.
        // Per Anchor convention this is computed from the account name; we accept any
        // account that decodes successfully. If decode fails, skip.

        const programInstance = await DLMM.getPositionsAccount(connection, pubkey).catch(
          () => null
        );
        if (!programInstance) {
          // Fall back to manual decode: read the lbPair pubkey at offset 8 (after the 8-byte
          // discriminator) and owner at offset 8+32. Bytemuck C layout.
          const data = acctInfo.data;
          if (data.length < 8 + 32 + 32) continue;
          let lbPair: PublicKey;
          let owner: PublicKey;
          try {
            lbPair = new PublicKey(data.subarray(8, 8 + 32));
            owner = new PublicKey(data.subarray(8 + 32, 8 + 64));
          } catch {
            continue;
          }
          const snapshot = await analyzeDlmmPosition(
            pubkey.toBase58(),
            lbPair.toBase58(),
            owner.toBase58(),
            logs.signature
          ).catch((err) => {
            logger.debug("DLMM analyzer failed for candidate", {
              error: String(err),
              candidate: pubkey.toBase58(),
            });
            return null;
          });
          if (!snapshot) continue;
          for (const cb of this.callbacks) {
            try { await cb(snapshot); } catch (err) {
              logger.error("DLMM callback error", { error: String(err) });
            }
          }
        }
      } catch (err) {
        logger.debug("DLMM probe failed", { error: String(err), pubkey: pubkey.toBase58() });
      }
    }
  }
}
```

**NOTE on `DLMM.getPositionsAccount`:** Verify this helper exists in the SDK before writing the code as shown. If not, drop that path and use only the manual-decode fallback (offset 8 for lbPair, offset 40 for owner) which is sufficient. Run:
```
grep -n "getPositionAccount\|getPositionsAccount" node_modules/@meteora-ag/dlmm/dist/index.d.ts
```

If the helper does NOT exist, simplify the implementation to use ONLY the manual decode path (remove the if/else around `programInstance`).

- [ ] **Step 4: 5 tests PASS** — [ ] **Step 5: tsc clean** — [ ] **Step 6: Commit**

```bash
git add src/listener/dlmm-position-listener.ts tests/dlmm-position-listener.test.ts
git commit -m "feat(dlmm-buywall): position listener with manual account decode"
```

---

## Task 8: Wire into index.ts (alert-only)

**Files:** Modify `src/index.ts`.

- [ ] **Step 1: Add imports**

```typescript
import { DlmmPositionListener } from "./listener/dlmm-position-listener";
import { isDlmmBuyWall } from "./dlmm-buywall/filter";
import { createDlmmBuyWallStore } from "./dlmm-buywall/store";
import { formatDlmmBuyWallMessage } from "./dlmm-buywall/notifier";
import { DlmmPositionSnapshot, DetectedDlmmBuyWall } from "./dlmm-buywall/types";
import * as path from "path";
```

- [ ] **Step 2: Add module state next to `let poolListener: PoolListener;`**

```typescript
let dlmmListener: DlmmPositionListener | null = null;
const dlmmStore = createDlmmBuyWallStore(
  path.join(process.cwd(), "data", "dlmm-buywalls.json")
);
```

- [ ] **Step 3: Add handler ABOVE `handleNewPool` — TOCTOU-safe**

```typescript
async function handleDlmmBuyWall(snapshot: DlmmPositionSnapshot): Promise<void> {
  if (dlmmStore.hasSeen(snapshot.positionAddress)) return;
  // claim the slot synchronously to prevent double-notify
  dlmmStore.recordSeen(snapshot.positionAddress, {
    lbPair: snapshot.lbPairAddress,
    sol: snapshot.solValue,
  });

  const verdict = isDlmmBuyWall(snapshot, {
    minSol: config.dlmmBuywall.minSol,
    direction: config.dlmmBuywall.direction,
    singleSideThreshold: config.dlmmBuywall.singleSideThreshold,
  });
  if (!verdict.matched) {
    logger.debug("DLMM position not a buy wall", {
      position: snapshot.positionAddress.substring(0, 12),
      reason: verdict.reason,
    });
    return;
  }

  const wall: DetectedDlmmBuyWall = { ...snapshot, matchedReason: verdict.reason };
  logger.info("🚧 DLMM buy wall detected", {
    position: snapshot.positionAddress,
    sol: snapshot.solValue.toFixed(2),
    lbPair: snapshot.lbPairAddress,
  });
  await telegramBot.notifyAdmin(formatDlmmBuyWallMessage(wall));
}
```

- [ ] **Step 4: In `main()` after `poolListener.start();` and before `startMonitor();`:**

```typescript
  if (config.dlmmBuywall.enabled) {
    dlmmListener = new DlmmPositionListener();
    dlmmListener.onPositionSnapshot(handleDlmmBuyWall);
    dlmmListener.start();
    logger.info("DLMM buy wall tracker enabled", {
      minSol: config.dlmmBuywall.minSol,
      direction: config.dlmmBuywall.direction,
    });
  } else {
    logger.info("DLMM buy wall tracker disabled (DLMM_BUYWALL_ENABLED=true)");
  }
```

- [ ] **Step 5: Update shutdown:**

```typescript
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    poolListener.stop();
    if (dlmmListener) dlmmListener.stop();
    stopMonitor();
    await telegramBot.stop();
    process.exit(0);
  };
```

- [ ] **Step 6: tsc clean + full vitest suite still passes**

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat(dlmm-buywall): wire listener + alert-only handler into main"
```

**Critical:** This handler MUST NOT call any wallet, swap, or openPosition code. Verify by grepping `git diff HEAD~1 -- src/index.ts | grep -E "openPosition|swap|jupiter|getWallet|swapSolForToken"` — should return nothing in NEW lines.

---

## Task 9: `/dlmm_buywalls` Telegram command + env docs

- [ ] **Step 1: Inside `registerAdminCommands()` after `/buywalls` (or `/history`), add:**

```typescript
  telegramBot.registerCommand("dlmm_buywalls", async (ctx) => {
    const count = dlmmStore.size();
    await ctx.reply(
      `🚧 <b>DLMM Buy Wall Tracker</b>\n` +
        `Enabled: ${config.dlmmBuywall.enabled ? "yes" : "no"}\n` +
        `Min SOL: ${config.dlmmBuywall.minSol}\n` +
        `Direction: ${config.dlmmBuywall.direction}\n` +
        `Single-side threshold: ${(config.dlmmBuywall.singleSideThreshold * 100).toFixed(0)}%\n` +
        `Walls tracked: ${count}`,
      { parse_mode: "HTML" }
    );
  });
```

- [ ] **Step 2: Update `.env.example`** — append:

```
# === DLMM Buy Wall Tracker (detection only, no auto-trade) ===
# Alerts on Telegram when someone opens a large single-sided SOL position
# on a Meteora DLMM pool (real concentrated liquidity, bin-based).
#
# Direction semantics:
#   below = bins below active bin hold SOL (classic buy wall — SOL waiting to buy the token)
#   above = bins above active bin hold SOL (only relevant if SOL is the BASE token of the pool)
#   either = both directions
DLMM_BUYWALL_ENABLED=false
DLMM_BUYWALL_MIN_SOL=50
DLMM_BUYWALL_DIRECTION=below
DLMM_BUYWALL_SINGLE_SIDE_THRESHOLD=0.95
```

- [ ] **Step 3: tsc clean + tests pass**

- [ ] **Step 4: Commit**

```bash
git add src/index.ts .env.example
git commit -m "feat(dlmm-buywall): /dlmm_buywalls Telegram command + env docs"
```

---

## Task 10: Final whole-feature review

After all tasks complete, dispatch a code-reviewer subagent to review the entire diff against `claude/telegram-alert-bot-lfBXu` (the branch base). Focus checks:

1. **No auto-trade paths.** `git diff HEAD claude/telegram-alert-bot-lfBXu -- src/index.ts | grep -E "openPosition|swap|jupiter|getWallet|swapSolForToken"` should match only EXISTING lines (DAMM v2 pool tailer paths), not new ones in the DLMM handler.
2. **All math comes from the SDK.** No homegrown `BN.mul().div(Q64)` style code anywhere in `src/dlmm-buywall/`. Use `getPriceOfBinByBinId` only.
3. **Tests have magnitude assertions, not just `.gtn(0)`.** The analyzer test asserts `solValue > 74 && < 76`.
4. **TOCTOU-safe dedup.** `recordSeen` is called BEFORE the async filter step in `handleDlmmBuyWall`.
5. **Position owner read directly** from `positionData.owner` (DLMM exposes it), not from TX fee payer.
6. **`tsc --noEmit`** clean. **`vitest run`** passes all tests.
7. **No env vars accidentally added** to `src/config.ts` beyond the `dlmmBuywall` block.

If any of these fail: dispatch a fix subagent with the specific issues quoted.
