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
