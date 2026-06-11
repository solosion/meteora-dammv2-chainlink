import * as fs from "fs";
import * as path from "path";
import { DetectedDlmmBuyWall } from "./types";

export type WallStatus = "active" | "confirmed" | "removed";

export interface WallRecord extends DetectedDlmmBuyWall {
  tokenSymbol?: string;
  tokenName?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  priceChange24h?: number;
  solPriceUsd?: number;
  signalScore?: number;
  /** Lifecycle: active (default) → confirmed (still standing after 1h) or removed (pulled). */
  status?: WallStatus;
  /** Last time the monitor re-checked this wall on-chain. */
  lastCheckedAt?: string;
  /** When the status last changed (confirmed/removed). */
  statusChangedAt?: string;
  /** SOL value measured at the last check. */
  currentSolValue?: number;
}

export interface DlmmBuyWallStore {
  hasSeen(positionAddress: string): boolean;
  recordSeen(positionAddress: string, meta: Record<string, unknown>): void;
  recordWall(wall: WallRecord): void;
  updateWall(positionAddress: string, patch: Partial<WallRecord>): void;
  getWalls(): Array<WallRecord & { firstSeenAt: string }>;
  size(): number;
  flush(): void;
}

interface SeenEntry {
  positionAddress: string;
  firstSeenAt: string;
  meta: Record<string, unknown>;
}

interface FileContents {
  seen: SeenEntry[];
}

function entryToWall(entry: SeenEntry): (WallRecord & { firstSeenAt: string }) | null {
  const m = entry.meta as Partial<WallRecord> & { lbPair?: string; sol?: number; reason?: string };
  const solValue = typeof m.solValue === "number" ? m.solValue : typeof m.sol === "number" ? m.sol : null;
  const lbPair = m.lbPairAddress ?? m.lbPair;
  if (solValue === null || !lbPair) return null;

  return {
    positionAddress: entry.positionAddress,
    lbPairAddress: lbPair,
    owner: m.owner ?? "",
    tokenXMint: m.tokenXMint ?? "",
    tokenYMint: m.tokenYMint ?? "",
    tokenXDecimals: m.tokenXDecimals ?? 0,
    tokenYDecimals: m.tokenYDecimals ?? 0,
    totalXAmount: m.totalXAmount ?? 0,
    totalYAmount: m.totalYAmount ?? 0,
    lowerBinId: m.lowerBinId ?? 0,
    upperBinId: m.upperBinId ?? 0,
    activeBinId: m.activeBinId ?? 0,
    binStep: m.binStep ?? 0,
    currentPrice: m.currentPrice ?? 0,
    rangeMinPrice: m.rangeMinPrice ?? 0,
    rangeMaxPrice: m.rangeMaxPrice ?? 0,
    solIsTokenY: m.solIsTokenY ?? true,
    solValue,
    solFraction: m.solFraction ?? 1,
    binCount: m.binCount ?? Math.max(1, (m.upperBinId ?? 0) - (m.lowerBinId ?? 0) + 1),
    solPerBin: m.solPerBin ?? 0,
    rangeOrientation: m.rangeOrientation ?? "below",
    detectedAt: m.detectedAt ?? entry.firstSeenAt,
    txSignature: m.txSignature ?? "",
    matchedReason: m.matchedReason ?? m.reason ?? "",
    tokenSymbol: m.tokenSymbol,
    tokenName: m.tokenName,
    priceUsd: m.priceUsd,
    marketCapUsd: m.marketCapUsd,
    liquidityUsd: m.liquidityUsd,
    volume24hUsd: m.volume24hUsd,
    priceChange24h: m.priceChange24h,
    solPriceUsd: m.solPriceUsd,
    signalScore: m.signalScore,
    status: m.status,
    lastCheckedAt: m.lastCheckedAt,
    statusChangedAt: m.statusChangedAt,
    currentSolValue: m.currentSolValue,
    firstSeenAt: entry.firstSeenAt,
  };
}

export function createDlmmBuyWallStore(filePath: string): DlmmBuyWallStore {
  const seen = new Map<string, SeenEntry>();
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as FileContents;
      for (const entry of parsed.seen ?? []) seen.set(entry.positionAddress, entry);
    } catch {
      // corrupt — start fresh
    }
  }
  function flushSync(): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ seen: Array.from(seen.values()) }, null, 2));
  }
  function persist(): void {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      flushSync();
    }, 500);
  }
  function recordSeen(a: string, m: Record<string, unknown>): void {
    if (seen.has(a)) return;
    seen.set(a, { positionAddress: a, firstSeenAt: new Date().toISOString(), meta: m });
    persist();
  }
  return {
    hasSeen: (a) => seen.has(a),
    recordSeen,
    recordWall: (wall) => {
      recordSeen(wall.positionAddress, wall as unknown as Record<string, unknown>);
    },
    updateWall: (positionAddress, patch) => {
      const entry = seen.get(positionAddress);
      if (!entry) return;
      entry.meta = { ...entry.meta, ...patch };
      persist();
    },
    getWalls: () => {
      const walls: Array<WallRecord & { firstSeenAt: string }> = [];
      for (const entry of seen.values()) {
        const wall = entryToWall(entry);
        if (wall) walls.push(wall);
      }
      walls.sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? 1 : -1));
      return walls;
    },
    size: () => seen.size,
    flush: flushSync,
  };
}
