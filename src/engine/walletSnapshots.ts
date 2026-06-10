import type { PlaceOrderResult } from "../connectors/orderExecution.js";
import type { LivePosition } from "../types/index.js";
import type { Side } from "../types/index.js";
import { settleRedeemCashInUsd } from "./settleAssumptions.js";
import { roundMoney, roundPrice } from "./tradeWebhook.js";

export type EventExitSnapshots = {
  balanceUsdcAtEntry: number | null;
  balanceUsdcAtExit: number | null;
  balanceUsdcBeforeExit: number;
  pnlNet: number;
  roundTripNotionalUsd: number;
};

function entryCostUsd(position: LivePosition): number {
  const entryPriceReal = position.entryPriceReal ?? position.entryPrice ?? 0;
  const sizeUsd =
    position.sizeUsd != null && position.sizeUsd > 0
      ? position.sizeUsd
      : entryPriceReal > 0
        ? roundMoney(position.sizeShares * entryPriceReal)
        : 0;
  return roundMoney(position.sizeShares * entryPriceReal || sizeUsd);
}

function entryCashOutUsd(position: LivePosition, entryCost: number): number {
  return position.entryCashOutUsd ?? roundMoney(entryCost + (position.entryFeeUsd ?? 0));
}

function exitPriceFromResolution(side: Side, resolvedYesPrice: number): number {
  return roundPrice(side === "YES" ? resolvedYesPrice : 1 - resolvedYesPrice);
}

/** PnL from trade snapshots — no delayed global wallet read for round-trip metrics. */
export function resolveFakExitSnapshots(input: {
  position: LivePosition;
  sellResult: PlaceOrderResult;
  exitQuotePrice: number;
  balanceUsdcBeforeExit: number;
}): EventExitSnapshots {
  const { position, sellResult, exitQuotePrice, balanceUsdcBeforeExit } = input;

  const exitPriceReal =
    sellResult.fillPrice != null && sellResult.fillPrice > 0
      ? sellResult.fillPrice
      : exitQuotePrice;
  const exitProceedsUsd =
    sellResult.fillUsd != null && sellResult.fillUsd > 0
      ? sellResult.fillUsd
      : roundMoney(position.sizeShares * exitPriceReal);

  const entryCost = entryCostUsd(position);
  const entryCashOut = entryCashOutUsd(position, entryCost);
  const pnlNet = roundMoney(exitProceedsUsd - entryCashOut);

  const balanceAtEntry = position.balanceUsdcAtEntry ?? null;
  const balanceAtExit =
    balanceAtEntry != null
      ? roundMoney(balanceAtEntry + pnlNet)
      : roundMoney(balanceUsdcBeforeExit + exitProceedsUsd);

  return {
    balanceUsdcAtEntry: balanceAtEntry,
    balanceUsdcAtExit: balanceAtExit,
    balanceUsdcBeforeExit,
    pnlNet,
    roundTripNotionalUsd: roundMoney(entryCashOut + exitProceedsUsd)
  };
}

/** Settle PnL from entry snapshot + exit-leg redeem credit or resolution proceeds. */
export function resolveSettleExitSnapshots(input: {
  position: LivePosition;
  resolvedYesPrice: number | null;
  assumeTotalLoss: boolean;
  balanceUsdcBeforeExit: number;
  /** Post-delay balance read — used only to detect redeem credit on this leg, not full wallet exit. */
  balanceUsdcAfterSettleLeg?: number;
}): EventExitSnapshots {
  const { position, resolvedYesPrice, assumeTotalLoss, balanceUsdcBeforeExit } = input;
  const entryCost = entryCostUsd(position);
  const entryCashOut = entryCashOutUsd(position, entryCost);
  const balanceAtEntry = position.balanceUsdcAtEntry ?? null;

  let exitProceedsUsd = 0;
  if (assumeTotalLoss) {
    exitProceedsUsd = 0;
  } else if (resolvedYesPrice != null) {
    const exitPriceReal = exitPriceFromResolution(position.side, resolvedYesPrice);
    exitProceedsUsd = roundMoney(position.sizeShares * exitPriceReal);
  } else {
    const redeemCashIn = settleRedeemCashInUsd(
      balanceUsdcBeforeExit,
      input.balanceUsdcAfterSettleLeg
    );
    exitProceedsUsd = redeemCashIn ?? 0;
  }

  const pnlNet = assumeTotalLoss
    ? roundMoney(-entryCashOut)
    : roundMoney(exitProceedsUsd - entryCashOut);

  const balanceAtExit =
    balanceAtEntry != null ? roundMoney(balanceAtEntry + pnlNet) : null;

  const roundTripNotionalUsd = assumeTotalLoss
    ? entryCashOut
    : roundMoney(entryCashOut + exitProceedsUsd);

  return {
    balanceUsdcAtEntry: balanceAtEntry,
    balanceUsdcAtExit: balanceAtExit,
    balanceUsdcBeforeExit,
    pnlNet,
    roundTripNotionalUsd
  };
}
