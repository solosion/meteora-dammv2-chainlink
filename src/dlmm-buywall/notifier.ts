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
