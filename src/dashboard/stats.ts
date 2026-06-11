import { WallRecord } from "../dlmm-buywall/store";

export interface HourBucket {
  hourIso: string;
  count: number;
  totalSol: number;
}

export interface TokenLeaderboardEntry {
  tokenMint: string;
  tokenSymbol: string;
  wallCount: number;
  totalSol: number;
  biggestSol: number;
  lastSeenAt: string;
}

export interface WallStats {
  last24h: { count: number; totalSol: number; biggestSol: number };
  allTime: { count: number; totalSol: number };
  hourly: HourBucket[];
  leaderboard: TokenLeaderboardEntry[];
}

type StoredWall = WallRecord & { firstSeenAt: string };

export function wallTokenMint(wall: WallRecord): string {
  return wall.solIsTokenY ? wall.tokenXMint : wall.tokenYMint;
}

/**
 * Aggregate stored walls into dashboard stats.
 * `now` is injectable for tests.
 */
export function computeWallStats(walls: StoredWall[], now: Date = new Date()): WallStats {
  const dayAgo = now.getTime() - 24 * 3600 * 1000;

  let count24 = 0;
  let sol24 = 0;
  let biggest24 = 0;
  let solAll = 0;

  // 24 hourly buckets, oldest first
  const buckets: HourBucket[] = [];
  const bucketIndex = new Map<string, HourBucket>();
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600 * 1000);
    d.setMinutes(0, 0, 0);
    const iso = d.toISOString();
    const bucket = { hourIso: iso, count: 0, totalSol: 0 };
    buckets.push(bucket);
    bucketIndex.set(iso, bucket);
  }

  const byToken = new Map<string, TokenLeaderboardEntry>();

  for (const wall of walls) {
    const t = new Date(wall.firstSeenAt).getTime();
    if (Number.isNaN(t)) continue;
    solAll += wall.solValue;

    if (t >= dayAgo) {
      count24++;
      sol24 += wall.solValue;
      if (wall.solValue > biggest24) biggest24 = wall.solValue;

      const hour = new Date(t);
      hour.setMinutes(0, 0, 0);
      const bucket = bucketIndex.get(hour.toISOString());
      if (bucket) {
        bucket.count++;
        bucket.totalSol += wall.solValue;
      }

      const mint = wallTokenMint(wall);
      const existing = byToken.get(mint);
      if (existing) {
        existing.wallCount++;
        existing.totalSol += wall.solValue;
        if (wall.solValue > existing.biggestSol) existing.biggestSol = wall.solValue;
        if (wall.firstSeenAt >= existing.lastSeenAt) {
          existing.lastSeenAt = wall.firstSeenAt;
        }
        if (wall.tokenSymbol && (!existing.tokenSymbol || wall.firstSeenAt >= existing.lastSeenAt)) {
          existing.tokenSymbol = wall.tokenSymbol;
        }
      } else {
        byToken.set(mint, {
          tokenMint: mint,
          tokenSymbol: wall.tokenSymbol ?? "",
          wallCount: 1,
          totalSol: wall.solValue,
          biggestSol: wall.solValue,
          lastSeenAt: wall.firstSeenAt,
        });
      }
    }
  }

  const leaderboard = Array.from(byToken.values())
    .sort((a, b) => b.totalSol - a.totalSol)
    .slice(0, 10);

  return {
    last24h: { count: count24, totalSol: sol24, biggestSol: biggest24 },
    allTime: { count: walls.length, totalSol: solAll },
    hourly: buckets,
    leaderboard,
  };
}
