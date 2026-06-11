import { WallRecord } from "./store";
import {
  computeWallMetrics,
  classifyWallTier,
  classifySupportStrength,
  classifyRelativeTier,
  computeSignalScore,
  scoreLabel,
} from "./metrics";

function formatUsd(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

function ageMinutes(wall: WallRecord & { firstSeenAt?: string }): number {
  const seenAt = wall.firstSeenAt ?? wall.detectedAt;
  const t = new Date(seenAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((Date.now() - t) / 60_000));
}

/**
 * Alert: a previously detected wall was pulled. The support is gone —
 * possible fake signal, exit indicator if you entered on this wall.
 */
export function formatWallRemovedMessage(
  wall: WallRecord & { firstSeenAt?: string },
  lastKnownSol: number
): string {
  const tokenMint = wall.solIsTokenY ? wall.tokenXMint : wall.tokenYMint;
  const token = wall.tokenSymbol ?? tokenMint.substring(0, 8) + "…";
  const mins = ageMinutes(wall);
  return (
    `⚠️ <b>Buy Wall ENTFERNT</b> — ${token}\n\n` +
    `Die Wall (${wall.solValue.toFixed(1)} SOL${wall.signalScore ? `, Score ${wall.signalScore}` : ""}) ` +
    `wurde nach ${mins} min abgezogen` +
    (lastKnownSol > 0 ? ` (Rest: ${lastKnownSol.toFixed(1)} SOL)` : "") +
    `.\n` +
    `Der Support ist weg — mögliches Fake-Signal. ` +
    `Falls du auf diese Wall eingestiegen bist: Exit prüfen.\n\n` +
    `🏊 Pool: <code>${wall.lbPairAddress}</code>\n` +
    `🔗 <a href="https://dexscreener.com/solana/${tokenMint}">Chart</a> | ` +
    `<a href="https://app.meteora.ag/dlmm/${wall.lbPairAddress}">Pool</a>`
  );
}

/**
 * Alert: a wall is still standing after the confirmation window —
 * the owner is committed, signal significance increases.
 */
export function formatWallConfirmedMessage(
  wall: WallRecord & { firstSeenAt?: string },
  currentSol: number
): string {
  const tokenMint = wall.solIsTokenY ? wall.tokenXMint : wall.tokenYMint;
  const token = wall.tokenSymbol ?? tokenMint.substring(0, 8) + "…";
  const mins = ageMinutes(wall);
  return (
    `✅ <b>Buy Wall BESTÄTIGT</b> — ${token}\n\n` +
    `Die Wall steht seit ${mins} min und hält ${currentSol.toFixed(1)} SOL ` +
    `(ursprünglich ${wall.solValue.toFixed(1)} SOL${wall.signalScore ? `, Score ${wall.signalScore}` : ""}).\n` +
    `Der Owner ist committed — die Signal-Signifikanz steigt.\n\n` +
    `🏊 Pool: <code>${wall.lbPairAddress}</code>\n` +
    `🔗 <a href="https://dexscreener.com/solana/${tokenMint}">Chart</a> | ` +
    `<a href="https://app.meteora.ag/dlmm/${wall.lbPairAddress}">Pool</a>`
  );
}

export function formatDlmmBuyWallMessage(wall: WallRecord): string {
  const tokenMint = wall.solIsTokenY ? wall.tokenXMint : wall.tokenYMint;
  const tier = classifyWallTier(wall.solValue);
  const metrics = computeWallMetrics(wall);
  const isSupport = wall.rangeOrientation === "below";

  const relTier = classifyRelativeTier(
    wall.solValue,
    wall.volume24hUsd ?? 0,
    wall.solPriceUsd ?? 0
  );

  // Use the score computed at detection time so Telegram and dashboard
  // always show the same number; compute only as fallback.
  const score =
    wall.signalScore ??
    computeSignalScore({
      solValue: wall.solValue,
      distancePct: metrics.distancePct,
      solPerBin: wall.solPerBin,
      solFraction: wall.solFraction,
      wallToVolumePct: relTier.wallToVolumePct || undefined,
    });
  const sl = scoreLabel(score);

  const headline = isSupport
    ? `${sl.emoji} <b>DLMM Buy Wall (Support)</b> — Score ${score}/100`
    : `${sl.emoji} <b>DLMM Sell Wall (Resistance)</b> — Score ${score}/100`;

  const tokenLine = wall.tokenSymbol
    ? `🪙 <b>Token:</b> ${wall.tokenSymbol}${wall.tokenName ? ` (${wall.tokenName})` : ""}\n` +
      `   <code>${tokenMint}</code>\n`
    : `🪙 <b>Token:</b> <code>${tokenMint}</code>\n`;

  const marketLines: string[] = [];
  if (wall.marketCapUsd && wall.marketCapUsd > 0) {
    marketLines.push(`MCap: $${formatUsd(wall.marketCapUsd)}`);
  }
  if (wall.priceUsd) {
    marketLines.push(`Preis: $${wall.priceUsd}`);
  }
  if (wall.priceChange24h !== undefined) {
    const ch = wall.priceChange24h;
    marketLines.push(`24h: ${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%`);
  }
  const marketLine = marketLines.length > 0 ? `📊 ${marketLines.join(" | ")}\n` : "";

  const volumeLine = wall.volume24hUsd && wall.volume24hUsd > 0
    ? `🌊 <b>Vol 24h:</b> $${formatUsd(wall.volume24hUsd)} — Wall ist ${relTier.label} (${relTier.wallToVolumePct.toFixed(1)}% des Volumens)\n`
    : "";

  const concLine = `🎯 <b>Konzentration:</b> ${wall.solPerBin.toFixed(1)} SOL/Bin (${wall.binCount} Bins)\n`;

  const distanceLine = isSupport
    ? `📏 <b>Distanz:</b> ${metrics.distancePct.toFixed(1)}% (${classifySupportStrength(metrics.distancePct)}), Support bis -${metrics.depthPct.toFixed(1)}%\n`
    : `📏 <b>Distanz:</b> +${metrics.distancePct.toFixed(1)}%, Resistance bis +${metrics.depthPct.toFixed(1)}%\n`;

  return (
    `${headline}\n\n` +
    `💰 <b>Größe:</b> ${wall.solValue.toFixed(1)} SOL ${tier.emoji}` +
    `${wall.solPriceUsd ? ` (~$${formatUsd(wall.solValue * wall.solPriceUsd)})` : ""}` +
    ` — ${(wall.solFraction * 100).toFixed(0)}% einseitig\n` +
    distanceLine +
    concLine +
    volumeLine +
    `\n` +
    tokenLine +
    marketLine +
    `🏊 <b>Pool:</b> <code>${wall.lbPairAddress}</code>\n` +
    `👤 <b>Owner:</b> <code>${wall.owner}</code>\n\n` +
    `🔗 <a href="https://solscan.io/tx/${wall.txSignature}">TX</a> | ` +
    `<a href="https://app.meteora.ag/dlmm/${wall.lbPairAddress}">Pool</a> | ` +
    `<a href="https://dexscreener.com/solana/${tokenMint}">Chart</a>`
  );
}
