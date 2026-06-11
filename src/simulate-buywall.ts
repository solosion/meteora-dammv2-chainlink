/**
 * Simulation: kompletter DLMM Buy-Wall-Durchlauf mit 3 Beispiel-Szenarien.
 * Zeigt: Filter-Entscheidung, Signal-Score, fertige Telegram-Nachricht.
 * Braucht keine .env / keine API-Keys.
 *
 * Usage: npm run simulate:buywall
 */
import { isDlmmBuyWall } from "./dlmm-buywall/filter";
import { formatDlmmBuyWallMessage } from "./dlmm-buywall/notifier";
import {
  computeWallMetrics,
  classifyRelativeTier,
  computeSignalScore,
  scoreLabel,
} from "./dlmm-buywall/metrics";
import { WallRecord } from "./dlmm-buywall/store";

const cfg = { minSol: 50, direction: "below" as const, singleSideThreshold: 0.95 };

function makeWall(over: Partial<WallRecord>): WallRecord {
  return {
    positionAddress: "7xKqPos9fA3mWvB2cD4eF5gH6jK8mN1pQ2rS3tU4vW5x",
    lbPairAddress: "9aBcLbPair2dE3fG4hJ5kL6mN7pQ8rS9tU1vW2xY3zA4",
    owner: "WhaLe5oWn3rAddre55Ba5e58F0rmat111111111111",
    tokenXMint: "WIFmint1111111111111111111111111111111111111",
    tokenYMint: "So11111111111111111111111111111111111111112",
    tokenXDecimals: 6,
    tokenYDecimals: 9,
    totalXAmount: 0,
    totalYAmount: 0,
    lowerBinId: -120,
    upperBinId: -80,
    activeBinId: 0,
    binStep: 100,
    currentPrice: 0.00042,
    rangeMinPrice: 0.00038,
    rangeMaxPrice: 0.000412,
    solIsTokenY: true,
    solValue: 0,
    solFraction: 1,
    binCount: 41,
    solPerBin: 0,
    rangeOrientation: "below",
    detectedAt: new Date().toISOString(),
    txSignature: "5KtPSimTxSig111111111111111111111111111111111111111111111111111",
    matchedReason: "",
    ...over,
  };
}

const scenarios: Array<{ name: string; wall: WallRecord }> = [
  {
    name: "Szenario 1: Whale-Wall, nah am Preis, kleines Token (STARKES SIGNAL)",
    wall: makeWall({
      solValue: 520,
      totalYAmount: 520,
      solPerBin: 520 / 41,
      tokenSymbol: "MOON",
      tokenName: "MoonCoin",
      marketCapUsd: 850_000,
      volume24hUsd: 320_000,
      priceChange24h: 12.4,
      solPriceUsd: 152,
    }),
  },
  {
    name: "Szenario 2: Mittlere Wall, gutes Token-Volumen (GUTES SIGNAL)",
    wall: makeWall({
      positionAddress: "3mNoPos8eB2lVuA1bC3dE4fG5hJ7lM9oP1qR2sT3uV4w",
      solValue: 95,
      totalYAmount: 95,
      binCount: 15,
      solPerBin: 95 / 15,
      lowerBinId: -55,
      upperBinId: -41,
      rangeMinPrice: 0.000405,
      rangeMaxPrice: 0.000416,
      tokenSymbol: "PEPE2",
      tokenName: "Pepe Two",
      marketCapUsd: 2_400_000,
      volume24hUsd: 1_800_000,
      priceChange24h: -3.1,
      solPriceUsd: 152,
    }),
  },
  {
    name: "Szenario 3: Zu klein — wird vom Filter ABGELEHNT",
    wall: makeWall({
      positionAddress: "1aSmallPos11111111111111111111111111111111111",
      solValue: 22,
      totalYAmount: 22,
      solPerBin: 22 / 41,
      tokenSymbol: "DUST",
    }),
  },
];

console.log("═".repeat(70));
console.log("  DLMM BUY WALL TRACKER — SIMULATION (3 Szenarien)");
console.log("  Config: minSol=50, direction=below, singleSideThreshold=0.95");
console.log("═".repeat(70));

for (const { name, wall } of scenarios) {
  console.log("\n" + "─".repeat(70));
  console.log(`▶ ${name}`);
  console.log("─".repeat(70));

  // Schritt 1: Filter (wie im Listener)
  const filterResult = isDlmmBuyWall(wall, cfg);
  console.log(`\n[1] FILTER: ${filterResult.matched ? "✅ MATCH" : "❌ REJECTED"} — ${filterResult.reason}`);
  if (!filterResult.matched) {
    console.log("    → Kein Alert, Position wird nur als 'seen' markiert.\n");
    continue;
  }
  wall.matchedReason = filterResult.reason;

  // Schritt 2: Scoring (wie in index.ts handleDlmmBuyWall)
  const metrics = computeWallMetrics(wall);
  const relTier = classifyRelativeTier(wall.solValue, wall.volume24hUsd ?? 0, wall.solPriceUsd ?? 0);
  wall.signalScore = computeSignalScore({
    solValue: wall.solValue,
    distancePct: metrics.distancePct,
    solPerBin: wall.solPerBin,
    solFraction: wall.solFraction,
    wallToVolumePct: relTier.wallToVolumePct || undefined,
  });
  const label = scoreLabel(wall.signalScore);
  console.log(`[2] SCORING: ${wall.signalScore}/100 → ${label.emoji} ${label.label}`);
  console.log(`    Distanz zum Preis: ${metrics.distancePct.toFixed(2)}% | SOL/Bin: ${wall.solPerBin.toFixed(2)} | Wall/Volumen: ${relTier.wallToVolumePct.toFixed(1)}% (${relTier.label})`);

  // Schritt 3: Telegram-Nachricht (HTML → hier als Plaintext angezeigt)
  const msg = formatDlmmBuyWallMessage(wall);
  console.log(`\n[3] TELEGRAM-NACHRICHT (so kommt sie bei dir an):\n`);
  console.log(
    msg
      .replace(/<\/?b>/g, "")
      .replace(/<\/?i>/g, "")
      .replace(/<\/?code>/g, "")
      .replace(/<a href="([^"]+)">([^<]+)<\/a>/g, "$2 → $1")
      .split("\n")
      .map((l) => "    " + l)
      .join("\n")
  );
}

console.log("\n" + "═".repeat(70));
console.log("  Ende der Simulation — im Live-Betrieb laufen diese Schritte");
console.log("  automatisch für jede neue DLMM-Position auf Solana.");
console.log("═".repeat(70));
