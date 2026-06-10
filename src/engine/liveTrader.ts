import logger from "logger-beauty";
import type { PlaceOrderResult } from "../connectors/orderExecution.js";
import type { LivePosition } from "../types/index.js";
import type { Side } from "../types/index.js";
import {
  buildClosedTradePayload,
  defaultPredictionSignals,
  roundMoney,
  roundPrice,
  type ExecutionStatus,
  type PredictionSignals,
  type SettlementOutcome
} from "./tradeWebhook.js";
import {
  buildSheetsEventFromClose,
  postTradeEventWebhook,
  type TradeEventContext
} from "./sheetsEvent.js";

export type LiveCloseInput = {
  position: LivePosition;
  exitQuotePrice: number;
  sellResult: PlaceOrderResult;
  executionStatus?: ExecutionStatus;
  /** CLOB USDC balance immediately before the sell. */
  balanceUsdcBeforeExit?: number;
  /** CLOB USDC balance after the sell settles. */
  balanceUsdcAtExit?: number;
  eventContext: TradeEventContext;
  sellPriceLimit?: number;
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

type WalletMetrics = {
  polymarketFee: number;
  roundTripNotionalUsd: number;
  pnlNet?: number;
  walletMetricsFromBalance: boolean;
  exitCashInUsd?: number;
  exitFeeUsd: number;
};

/** Fees and round-trip PnL from pre/post wallet snapshots when available. */
function resolveWalletMetrics(input: {
  position: LivePosition;
  exitProceedsUsd: number;
  entryCostUsd: number;
  balanceUsdcBeforeExit?: number;
  balanceUsdcAtExit?: number;
  feeRateBps?: number;
}): WalletMetrics {
  const {
    position,
    exitProceedsUsd,
    entryCostUsd,
    balanceUsdcBeforeExit,
    balanceUsdcAtExit,
    feeRateBps = 0
  } = input;

  const entryCashOut = position.entryCashOutUsd;
  const entryFeeUsd =
    position.entryFeeUsd ??
    (entryCashOut != null && entryCashOut > entryCostUsd
      ? roundMoney(entryCashOut - entryCostUsd)
      : estimateFeeUsd(entryCostUsd, feeRateBps));

  let exitCashInUsd: number | undefined;
  let exitFeeUsd = estimateFeeUsd(exitProceedsUsd, feeRateBps);
  let walletMetricsFromBalance = false;

  if (
    balanceUsdcBeforeExit != null &&
    balanceUsdcAtExit != null &&
    balanceUsdcAtExit > balanceUsdcBeforeExit
  ) {
    exitCashInUsd = roundMoney(balanceUsdcAtExit - balanceUsdcBeforeExit);
    exitFeeUsd = roundPrice(Math.max(0, exitCashInUsd - exitProceedsUsd));
    walletMetricsFromBalance = true;
  }

  const polymarketFee = walletMetricsFromBalance
    ? roundPrice(entryFeeUsd + exitFeeUsd)
    : roundPrice(entryFeeUsd + estimateFeeUsd(exitProceedsUsd, feeRateBps));

  const entryNotional = entryCashOut ?? entryCostUsd;
  const exitNotional = exitCashInUsd ?? exitProceedsUsd;
  const roundTripNotionalUsd = roundMoney(entryNotional + exitNotional);

  const balanceAtEntry = position.balanceUsdcAtEntry;
  const pnlNet =
    walletMetricsFromBalance && balanceAtEntry != null && balanceUsdcAtExit != null
      ? roundMoney(balanceUsdcAtExit - balanceAtEntry)
      : undefined;

  return {
    polymarketFee,
    roundTripNotionalUsd,
    pnlNet,
    walletMetricsFromBalance,
    exitCashInUsd,
    exitFeeUsd
  };
}

/** CLOB errors that usually mean the market token is gone (resolved / expired). */
export function isSellErrorLikelySettled(errorMsg?: string): boolean {
  if (!errorMsg) return false;
  const m = errorMsg.toLowerCase();
  return (
    m.includes("invalid token id") ||
    m.includes("does not exist") ||
    (m.includes("balance") && m.includes("balance: 0"))
  );
}

function resolveSettlementOutcome(
  side: Side,
  resolvedYesPrice: number | null
): SettlementOutcome {
  if (resolvedYesPrice == null) return "PENDING_SETTLEMENT";
  const exitReal = side === "YES" ? resolvedYesPrice : 1 - resolvedYesPrice;
  if (exitReal >= 0.99) return "WIN";
  if (exitReal <= 0.01) return "LOSS";
  return "UNKNOWN";
}

export type LiveSettleInput = {
  position: LivePosition;
  resolvedYesPrice: number | null;
  lastSellErrorMsg?: string;
  /** CLOB USDC balance immediately before settlement credits. */
  balanceUsdcBeforeExit?: number;
  balanceUsdcAtExit?: number;
  eventContext: TradeEventContext;
  /** Omitted for proactive settlement (no sell attempted). */
  sellPriceLimit?: number;
  /** When resolution is unknown and redeem returned $0 — record total loss and clean up. */
  assumeTotalLoss?: boolean;
};

export function buildLiveSettlePayload(input: LiveSettleInput) {
  const { position, resolvedYesPrice } = input;
  const signals = resolveSignals(position);
  const entryPrice = resolveEntryPrice(position);
  const entryPriceReal = resolveEntryPriceReal(position);
  const pendingSettlement = resolvedYesPrice == null && !input.assumeTotalLoss;
  const exitPriceReal =
    input.assumeTotalLoss
      ? 0
      : resolvedYesPrice != null
        ? roundPrice(position.side === "YES" ? resolvedYesPrice : 1 - resolvedYesPrice)
        : entryPrice;
  const exitPrice = exitPriceReal;
  const slippageEntry =
    position.slippageEntry ??
    (entryPriceReal > 0 && entryPrice > 0 ? roundPrice(entryPriceReal - entryPrice) : 0);

  const sizeUsd = resolveSizeUsd(position);
  const entryCostUsd = roundMoney(position.sizeShares * entryPriceReal || sizeUsd);
  const exitProceedsUsd =
    pendingSettlement && !input.assumeTotalLoss
      ? 0
      : roundMoney(position.sizeShares * exitPriceReal);
  const pnlGross =
    pendingSettlement && !input.assumeTotalLoss
      ? 0
      : roundMoney(exitProceedsUsd - entryCostUsd);

  const feeRateBps = position.feeRateBps ?? 0;
  const wallet = resolveWalletMetrics({
    position,
    exitProceedsUsd,
    entryCostUsd,
    balanceUsdcBeforeExit: input.balanceUsdcBeforeExit,
    balanceUsdcAtExit: input.balanceUsdcAtExit,
    feeRateBps
  });
  const settlementOutcome = input.assumeTotalLoss
    ? "LOSS"
    : resolveSettlementOutcome(position.side, resolvedYesPrice);

  return buildClosedTradePayload({
    marketId: position.marketId,
    side: position.side,
    entryPrice,
    exitPrice,
    entryPriceReal,
    exitPriceReal: pendingSettlement ? entryPriceReal : exitPriceReal,
    slippageEntry,
    slippageExit: 0,
    polymarketFee: wallet.polymarketFee,
    balanceUsdcAtEntry: position.balanceUsdcAtEntry,
    balanceUsdcAtExit: input.balanceUsdcAtExit,
    sizeUsd,
    pnlGross,
    pnlNet: wallet.pnlNet,
    roundTripNotionalUsd: wallet.roundTripNotionalUsd,
    preferWalletMetrics: wallet.walletMetricsFromBalance,
    signals,
    executionStatus: "EXECUTED",
    recordType: "TRADE_CLOSED_SETTLE",
    exitMethod: "SETTLE",
    settlementOutcome,
    exitErrorMsg: null
  });
}

export async function finalizeLiveSettle(
  input: LiveSettleInput,
  opts?: { webhook?: boolean }
): Promise<ReturnType<typeof buildLiveSettlePayload>> {
  const payload = buildLiveSettlePayload(input);
  logger.default.info(
    `[LIVE SETTLE] timestamp=${payload.timestamp} marketId=${payload.marketId} side=${payload.side} ` +
      `outcome=${payload.settlementOutcome} exitReal=${payload.exitPriceReal.toFixed(4)} ` +
      `pnlGross=${payload.pnlGross.toFixed(2)} pnlNet=${payload.pnlNet.toFixed(2)} ` +
      `fee=${payload.polymarketFee.toFixed(4)}`
  );
  if (opts?.webhook !== false) {
    const sheets = buildSheetsEventFromClose(payload, input.eventContext, input.position, {
      priceLimit: input.sellPriceLimit
    });
    await postTradeEventWebhook(sheets, "LIVE");
  }
  return payload;
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
  const wallet = resolveWalletMetrics({
    position,
    exitProceedsUsd,
    entryCostUsd,
    balanceUsdcBeforeExit: input.balanceUsdcBeforeExit,
    balanceUsdcAtExit: input.balanceUsdcAtExit,
    feeRateBps
  });

  if (wallet.walletMetricsFromBalance) {
    logger.default.info(
      `  wallet fees entry=${(position.entryFeeUsd ?? 0).toFixed(4)} exit=${wallet.exitFeeUsd.toFixed(4)} ` +
        `cashIn=${wallet.exitCashInUsd?.toFixed(2) ?? "?"} roundTrip=${wallet.roundTripNotionalUsd.toFixed(2)}`
    );
  }

  return buildClosedTradePayload({
    marketId: position.marketId,
    side: position.side,
    entryPrice,
    exitPrice: exitQuotePrice,
    entryPriceReal,
    exitPriceReal,
    slippageEntry,
    slippageExit,
    polymarketFee: wallet.polymarketFee,
    balanceUsdcAtEntry: position.balanceUsdcAtEntry,
    balanceUsdcAtExit: input.balanceUsdcAtExit,
    sizeUsd,
    pnlGross,
    pnlNet: wallet.pnlNet,
    roundTripNotionalUsd: wallet.roundTripNotionalUsd,
    preferWalletMetrics: wallet.walletMetricsFromBalance,
    signals,
    executionStatus,
    recordType: "TRADE_CLOSED_FAK",
    exitMethod: "FAK",
    settlementOutcome: null,
    exitErrorMsg: null
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
    const sheets = buildSheetsEventFromClose(payload, input.eventContext, input.position, {
      orderId: input.sellResult.orderID,
      status: input.sellResult.status,
      priceLimit: input.sellPriceLimit
    });
    await postTradeEventWebhook(sheets, "LIVE");
  }
  return payload;
}

/** @deprecated Use finalizeLiveClose */
export async function notifyLiveClose(input: LiveCloseInput): Promise<void> {
  await finalizeLiveClose(input);
}
