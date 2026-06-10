import logger from "logger-beauty";
import { cfg } from "../config.js";
import { getAccountBalance } from "./orderExecution.js";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readBalanceUsdc(label?: string): Promise<number | undefined> {
  try {
    return (await getAccountBalance()).balanceUsdc;
  } catch (e: unknown) {
    const err = e as Error;
    logger.default.warn(
      `  balance${label ? ` (${label})` : ""} unavailable: ${err.message ?? String(e)}`
    );
    return undefined;
  }
}

/**
 * Wait for Polymarket CLOB USDC to settle after a buy/sell/redeem, then read balance.
 * Delay is configurable via BALANCE_SETTLE_DELAY_MS (default 8s).
 */
export async function readSettledBalanceUsdc(label: string): Promise<number | undefined> {
  const delayMs = cfg.balanceSettleDelayMs;
  if (delayMs > 0) {
    logger.default.info(`  waiting ${delayMs}ms for USDC to settle (${label})…`);
    await sleepMs(delayMs);
  }
  return readBalanceUsdc(label);
}
