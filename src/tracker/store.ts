import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";

const DATA_DIR = path.join(process.cwd(), "data");
const POSITIONS_FILE = path.join(DATA_DIR, "positions.json");

export interface TrackedPosition {
  id: string;
  poolAddress: string;
  positionAddress: string;
  positionNftMint: string;
  tokenAMint: string;
  tokenBMint: string;
  tokenAAmount: string;
  tokenBAmount: string;
  entryValueSol: number;
  openedAt: string;
  txSignature: string;
  status: "open" | "closed";
  closedAt?: string;
  closeSignature?: string;
  closeReason?: string;
  pnlSol?: number;
}

export interface PositionStore {
  positions: TrackedPosition[];
  totalPnlSol: number;
  lastUpdated: string;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadStore(): PositionStore {
  ensureDataDir();
  if (!fs.existsSync(POSITIONS_FILE)) {
    return { positions: [], totalPnlSol: 0, lastUpdated: new Date().toISOString() };
  }
  try {
    const raw = fs.readFileSync(POSITIONS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    logger.warn("Could not parse positions file, starting fresh");
    return { positions: [], totalPnlSol: 0, lastUpdated: new Date().toISOString() };
  }
}

function saveStore(store: PositionStore): void {
  ensureDataDir();
  store.lastUpdated = new Date().toISOString();
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(store, null, 2));
}

export function addPosition(pos: Omit<TrackedPosition, "id" | "status">): TrackedPosition {
  const store = loadStore();
  const tracked: TrackedPosition = {
    ...pos,
    id: `pos_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    status: "open",
  };
  store.positions.push(tracked);
  saveStore(store);
  logger.info("Position tracked", { id: tracked.id, pool: pos.poolAddress });
  return tracked;
}

export function closeTrackedPosition(
  id: string,
  closeSignature: string,
  reason: string,
  pnlSol?: number
): void {
  const store = loadStore();
  const pos = store.positions.find((p) => p.id === id);
  if (!pos) {
    logger.warn(`Position ${id} not found in tracker`);
    return;
  }
  pos.status = "closed";
  pos.closedAt = new Date().toISOString();
  pos.closeSignature = closeSignature;
  pos.closeReason = reason;
  pos.pnlSol = pnlSol;
  if (pnlSol !== undefined) {
    store.totalPnlSol += pnlSol;
  }
  saveStore(store);
  logger.info("Position closed in tracker", { id, reason, pnlSol });
}

export function getOpenPositions(): TrackedPosition[] {
  const store = loadStore();
  return store.positions.filter((p) => p.status === "open");
}

export function getAllPositions(): TrackedPosition[] {
  return loadStore().positions;
}

export function getTotalPnl(): number {
  return loadStore().totalPnlSol;
}

export function getOpenPositionCount(): number {
  return getOpenPositions().length;
}

export function getTotalExposureSol(): number {
  return getOpenPositions().reduce((sum, p) => sum + p.entryValueSol, 0);
}
