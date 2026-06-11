import { WallRecord } from "./store";
import { computeWallMetrics, classifyWallTier, classifySupportStrength } from "./metrics";

function formatUsd(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

export function formatDlmmBuyWallMessage(wall: WallRecord): string {
  const tokenMint = wall.solIsTokenY ? wall.tokenXMint : wall.tokenYMint;
  const tier = classifyWallTier(wall.solValue);
  const metrics = computeWallMetrics(wall);
  const isSupport = wall.rangeOrientation === "below";

  const headline = isSupport
    ? `🟢 <b>DLMM Buy Wall (Support)</b> ${tier.emoji}`
    : `🔴 <b>DLMM Sell Wall (Resistance)</b> ${tier.emoji}`;

  const tokenLine = wall.tokenSymbol
    ? `🪙 <b>Token:</b> ${wall.tokenSymbol}${wall.tokenName ? ` (${wall.tokenName})` : ""}\n` +
      `   <code>${tokenMint}</code>\n`
    : `🪙 <b>Token:</b> <code>${tokenMint}</code>\n`;

  const marketLine =
    wall.marketCapUsd && wall.marketCapUsd > 0
      ? `📊 <b>Market Cap:</b> $${formatUsd(wall.marketCapUsd)}` +
        (wall.priceUsd ? ` | Preis: $${wall.priceUsd}` : "") +
        `\n`
      : "";

  const distanceLine = isSupport
    ? `📏 <b>Distanz zum Preis:</b> ${metrics.distancePct.toFixed(1)}% (${classifySupportStrength(metrics.distancePct)})\n` +
      `   Support-Zone reicht bis -${metrics.depthPct.toFixed(1)}%\n`
    : `📏 <b>Distanz zum Preis:</b> +${metrics.distancePct.toFixed(1)}%\n` +
      `   Resistance-Zone reicht bis +${metrics.depthPct.toFixed(1)}%\n`;

  return (
    `${headline}\n\n` +
    `💰 <b>Größe:</b> ${wall.solValue.toFixed(2)} SOL ` +
    `(${(wall.solFraction * 100).toFixed(1)}% einseitig) — ${tier.label}\n` +
    distanceLine +
    `📐 <b>Bins:</b> ${wall.lowerBinId} → ${wall.upperBinId} ` +
    `(aktiv: ${wall.activeBinId}, Step: ${wall.binStep})\n\n` +
    tokenLine +
    marketLine +
    `🏊 <b>Pool:</b> <code>${wall.lbPairAddress}</code>\n` +
    `👤 <b>Owner:</b> <code>${wall.owner}</code>\n\n` +
    `🔗 <a href="https://solscan.io/tx/${wall.txSignature}">TX ansehen</a> | ` +
    `<a href="https://app.meteora.ag/dlmm/${wall.lbPairAddress}">Pool öffnen</a> | ` +
    `<a href="https://dexscreener.com/solana/${tokenMint}">Chart</a>\n` +
    `\n<i>${wall.matchedReason}</i>`
  );
}
