import { roundMoney } from "./tradeWebhook.js";

export const SETTLE_REDEEM_MIN_USD = 0.05;

export function settleRedeemCashInUsd(
  balanceBefore?: number,
  balanceAfter?: number
): number | null {
  if (balanceBefore == null || balanceAfter == null) return null;
  if (balanceAfter <= balanceBefore) return 0;
  return roundMoney(balanceAfter - balanceBefore);
}

export function isMarketPastWindowEnd(
  marketId: string,
  marketEndSecFromSlug: (slug: string) => number | null,
  bufferSec = 2
): boolean {
  const endSec = marketEndSecFromSlug(marketId);
  if (endSec == null) return false;
  return Math.floor(Date.now() / 1000) >= endSec + bufferSec;
}

/** Expired market, Gamma unresolved, no USDC credited during settle wait → total loss. */
export function shouldAssumeTotalLossAfterSettle(input: {
  marketId: string;
  resolvedYesPrice: number | null;
  balanceUsdcBeforeExit?: number;
  balanceUsdcAtExit?: number;
  explicitAssume?: boolean;
  marketEndSecFromSlug: (slug: string) => number | null;
}): boolean {
  if (input.explicitAssume) return true;
  if (input.resolvedYesPrice != null) return false;
  if (!isMarketPastWindowEnd(input.marketId, input.marketEndSecFromSlug, 60)) return false;
  const redeemCashIn = settleRedeemCashInUsd(
    input.balanceUsdcBeforeExit,
    input.balanceUsdcAtExit
  );
  return redeemCashIn == null || redeemCashIn < SETTLE_REDEEM_MIN_USD;
}
