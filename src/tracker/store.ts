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
  // Live tracking fields
  currentValueSol?: number;
  pnlSol?: number;
  pnlPercent?: number;
  lastUpdated?: string;
  // Close fields
  closedAt?: string;
  closeSignature?: string;
  closeReason?: string;
  finalPnlSol?: number;
  // Metadata
  tokenSymbol?: string;
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
    return {
      positions: [],
      totalPnlSol: 0,
      lastUpdated: new Date().toISOString(),
    };
  }
  try {
    const raw = fs.readFileSync(POSITIONS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    logger.warn("Could not parse positions file, starting fresh");
    return {
      positions: [],
      totalPnlSol: 0,
      lastUpdated: new Date().toISOString(),
    };
  }
}

function saveStore(store: PositionStore): void {
  ensureDataDir();
  store.lastUpdated = new Date().toISOString();
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(store, null, 2));
}

export function addPosition(
  pos: Omit<TrackedPosition, "id" | "status">
): TrackedPosition {
  const store = loadStore();
  const tracked: TrackedPosition = {
    ...pos,
    id: `pos_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    status: "open",
    currentValueSol: pos.entryValueSol,
    pnlSol: 0,
    pnlPercent: 0,
    lastUpdated: new Date().toISOString(),
  };
  store.positions.push(tracked);
  saveStore(store);
  logger.info("Position tracked", { id: tracked.id, pool: pos.poolAddress });
  return tracked;
}

/**
 * Update live tracking values for a position.
 */
export function updatePositionValue(
  id: string,
  currentValueSol: number,
  pnlSol: number,
  pnlPercent: number
): void {
  const store = loadStore();
  const pos = store.positions.find((p) => p.id === id);
  if (!pos) return;
  pos.currentValueSol = currentValueSol;
  pos.pnlSol = pnlSol;
  pos.pnlPercent = pnlPercent;
  pos.lastUpdated = new Date().toISOString();
  saveStore(store);
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
  pos.finalPnlSol = pnlSol ?? pos.pnlSol;
  if (pos.finalPnlSol !== undefined) {
    store.totalPnlSol += pos.finalPnlSol;
  }
  saveStore(store);
  logger.info("Position closed in tracker", { id, reason, pnlSol });
}

export function getOpenPositions(): TrackedPosition[] {
  return loadStore().positions.filter((p) => p.status === "open");
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

/**
 * Get a formatted summary of all open positions for Telegram.
 */
export function getPositionsSummary(): string {
  const openPos = getOpenPositions();
  if (openPos.length === 0) return "Keine offenen Positionen.";

  let totalEntry = 0;
  let totalCurrent = 0;
  let lines: string[] = [];

  for (const pos of openPos) {
    const current = pos.currentValueSol ?? pos.entryValueSol;
    const pnl = pos.pnlSol ?? 0;
    const pnlPct = pos.pnlPercent ?? 0;
    const age = getAge(pos.openedAt);
    const symbol = pos.tokenSymbol ?? pos.poolAddress.substring(0, 8) + "...";
    const pnlSign = pnl >= 0 ? "+" : "";
    const emoji = pnl >= 0 ? "🟢" : "🔴";

    totalEntry += pos.entryValueSol;
    totalCurrent += current;

    lines.push(
      `${emoji} <b>${symbol}</b>\n` +
        `  Einstieg: ${pos.entryValueSol.toFixed(4)} SOL → Aktuell: ${current.toFixed(4)} SOL\n` +
        `  P&L: ${pnlSign}${pnl.toFixed(4)} SOL (${pnlSign}${pnlPct.toFixed(1)}%)\n` +
        `  Alter: ${age} | ID: <code>${pos.id}</code>`
    );
  }

  const totalPnl = totalCurrent - totalEntry;
  const totalPnlPct =
    totalEntry > 0 ? ((totalCurrent - totalEntry) / totalEntry) * 100 : 0;
  const totalSign = totalPnl >= 0 ? "+" : "";

  const header =
    `📊 <b>${openPos.length} offene Position(en)</b>\n` +
    `Gesamt: ${totalEntry.toFixed(4)} → ${totalCurrent.toFixed(4)} SOL ` +
    `(${totalSign}${totalPnl.toFixed(4)} SOL / ${totalSign}${totalPnlPct.toFixed(1)}%)\n` +
    `━━━━━━━━━━━━━━━━━━━━━`;

  return header + "\n\n" + lines.join("\n\n");
}

function getAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
