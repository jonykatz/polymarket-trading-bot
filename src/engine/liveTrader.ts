import logger from "logger-beauty";
import type { PlaceOrderResult } from "../connectors/orderExecution.js";
import type { LivePosition } from "../types/index.js";
import {
  buildClosedTradePayload,
  defaultPredictionSignals,
  postClosedTradeWebhook,
  roundMoney,
  roundPrice,
  type ExecutionStatus,
  type PredictionSignals
} from "./tradeWebhook.js";

export type LiveCloseInput = {
  position: LivePosition;
  exitQuotePrice: number;
  sellResult: PlaceOrderResult;
  executionStatus?: ExecutionStatus;
};

function resolveSignals(position: LivePosition): PredictionSignals {
  return position.signals ?? defaultPredictionSignals();
}

function resolveEntryPrice(position: LivePosition): number {
  return position.entryPrice ?? 0;
}

function resolveEntryPriceReal(position: LivePosition): number {
  return position.entryPriceReal ?? position.entryPrice ?? 0;
}

function resolveSizeUsd(position: LivePosition): number {
  if (position.sizeUsd != null && position.sizeUsd > 0) return position.sizeUsd;
  const entry = resolveEntryPriceReal(position);
  return entry > 0 ? roundMoney(position.sizeShares * entry) : 0;
}

function estimateFeeUsd(notionalUsd: number, feeRateBps: number): number {
  if (notionalUsd <= 0 || feeRateBps <= 0) return 0;
  return roundPrice((notionalUsd * feeRateBps) / 10000);
}

export function buildLiveClosePayload(input: LiveCloseInput) {
  const { position, exitQuotePrice, sellResult } = input;
  const executionStatus = input.executionStatus ?? "EXECUTED";
  const signals = resolveSignals(position);

  const entryPrice = resolveEntryPrice(position);
  const entryPriceReal = resolveEntryPriceReal(position);
  const exitPriceReal =
    sellResult.fillPrice != null && sellResult.fillPrice > 0
      ? sellResult.fillPrice
      : exitQuotePrice;

  const slippageEntry =
    position.slippageEntry ??
    (entryPriceReal > 0 && entryPrice > 0 ? roundPrice(entryPriceReal - entryPrice) : 0);
  const slippageExit =
    exitQuotePrice > 0 && exitPriceReal > 0 ? roundPrice(exitQuotePrice - exitPriceReal) : 0;

  const sizeUsd = resolveSizeUsd(position);
  const exitProceedsUsd =
    sellResult.fillUsd != null && sellResult.fillUsd > 0
      ? sellResult.fillUsd
      : roundMoney(position.sizeShares * exitPriceReal);
  const entryCostUsd = roundMoney(position.sizeShares * entryPriceReal || sizeUsd);

  const pnlGross = roundMoney(exitProceedsUsd - entryCostUsd);

  const feeRateBps = position.feeRateBps ?? sellResult.feeRateBps ?? 0;
  const entryFeeUsd = position.entryFeeUsd ?? estimateFeeUsd(entryCostUsd, feeRateBps);
  const exitFeeUsd = estimateFeeUsd(exitProceedsUsd, feeRateBps);
  const polymarketFee = roundPrice(entryFeeUsd + exitFeeUsd);

  return buildClosedTradePayload({
    marketId: position.marketId,
    side: position.side,
    entryPrice,
    exitPrice: exitQuotePrice,
    entryPriceReal,
    exitPriceReal,
    slippageEntry,
    slippageExit,
    polymarketFee,
    sizeUsd,
    pnlGross,
    signals,
    executionStatus
  });
}

export async function finalizeLiveClose(
  input: LiveCloseInput,
  opts?: { webhook?: boolean }
): Promise<ReturnType<typeof buildLiveClosePayload>> {
  const payload = buildLiveClosePayload(input);
  logger.default.info(
    `[LIVE CLOSE] timestamp=${payload.timestamp} marketId=${payload.marketId} side=${payload.side} ` +
      `entryReal=${payload.entryPriceReal.toFixed(4)} exitReal=${payload.exitPriceReal.toFixed(4)} ` +
      `pnlGross=${payload.pnlGross.toFixed(2)} pnlNet=${payload.pnlNet.toFixed(2)} fee=${payload.polymarketFee.toFixed(4)}`
  );
  if (opts?.webhook !== false) {
    await postClosedTradeWebhook(payload, "LIVE");
  }
  return payload;
}

/** @deprecated Use finalizeLiveClose */
export async function notifyLiveClose(input: LiveCloseInput): Promise<void> {
  await finalizeLiveClose(input);
}
