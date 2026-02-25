import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { getConnection } from "../solana/connection";
import { logger } from "../utils/logger";

let cpAmm: CpAmm | null = null;

export function getCpAmm(): CpAmm {
  if (!cpAmm) {
    const connection = getConnection();
    cpAmm = new CpAmm(connection);
    logger.info("Meteora DAMM v2 SDK initialized");
  }
  return cpAmm;
}
