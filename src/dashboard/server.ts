import * as http from "http";
import { URL } from "url";
import { logger } from "../utils/logger";
import { DlmmBuyWallStore } from "../dlmm-buywall/store";
import { computeWallMetrics } from "../dlmm-buywall/metrics";
import type { DlmmListenerStatus } from "../listener/dlmm-position-listener";
import { computeWallStats } from "./stats";
import { DASHBOARD_HTML } from "./page";

/** One entry in the recent-activity feed (all analyzed positions, matched or not). */
export interface ActivityEntry {
  at: string;
  positionAddress: string;
  lbPairAddress: string;
  solValue: number;
  matched: boolean;
  reason: string;
}

export interface DashboardDeps {
  store: DlmmBuyWallStore;
  getListenerStatus: () => DlmmListenerStatus | null;
  getActivity: () => ActivityEntry[];
  config: {
    enabled: boolean;
    minSol: number;
    direction: string;
    singleSideThreshold: number;
  };
  authToken: string;
}

const startedAt = Date.now();

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

export function buildApiResponse(deps: DashboardDeps, pathname: string): { status: number; body: unknown } | null {
  if (pathname === "/api/walls") {
    const walls = deps.store.getWalls().slice(0, 200).map((w) => ({
      ...w,
      metrics: computeWallMetrics(w),
    }));
    return { status: 200, body: { walls } };
  }
  if (pathname === "/api/stats") {
    return { status: 200, body: computeWallStats(deps.store.getWalls()) };
  }
  if (pathname === "/api/status") {
    return {
      status: 200,
      body: {
        enabled: deps.config.enabled,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        listener: deps.getListenerStatus(),
        config: {
          minSol: deps.config.minSol,
          direction: deps.config.direction,
          singleSideThreshold: deps.config.singleSideThreshold,
        },
        totalWalls: deps.store.size(),
      },
    };
  }
  if (pathname === "/api/activity") {
    return { status: 200, body: { activity: deps.getActivity() } };
  }
  return null;
}

export class DashboardServer {
  private server: http.Server | null = null;

  constructor(private deps: DashboardDeps) {}

  start(port: number, host: string): void {
    this.server = http.createServer((req, res) => {
      try {
        this.handle(req, res);
      } catch (err) {
        logger.error("Dashboard request error", { error: String(err) });
        json(res, 500, { error: "internal" });
      }
    });
    this.server.listen(port, host, () => {
      logger.info("Dashboard running", { url: `http://${host}:${port}` });
    });
    this.server.on("error", (err) => {
      logger.error("Dashboard server error", { error: String(err) });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      logger.info("Dashboard stopped");
    }
  }

  private isAuthorized(url: URL, req: http.IncomingMessage): boolean {
    if (!this.deps.authToken) return true;
    const queryToken = url.searchParams.get("token");
    if (queryToken === this.deps.authToken) return true;
    const auth = req.headers.authorization;
    return auth === `Bearer ${this.deps.authToken}`;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    if (req.method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return;
    }

    if (!this.isAuthorized(url, req)) {
      json(res, 401, { error: "unauthorized — append ?token=YOUR_TOKEN" });
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(DASHBOARD_HTML);
      return;
    }

    const api = buildApiResponse(this.deps, pathname);
    if (api) {
      json(res, api.status, api.body);
      return;
    }

    json(res, 404, { error: "not found" });
  }
}
