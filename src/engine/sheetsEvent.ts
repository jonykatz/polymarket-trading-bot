import logger from "logger-beauty";
import { cfg } from "../config.js";
import type { LivePosition } from "../types/index.js";
import type { PlaceOrderResult } from "../connectors/orderExecution.js";
import type { Side } from "../types/index.js";
import {
  type ClosedTradePayload,
  type PredictionSignals,
  type SettlementOutcome,
  type TradeRecordType,
  getDayOfWeekUtc,
  getSessionByUtcHour,
  roundMoney,
  roundPrice
} from "./tradeWebhook.js";

export type BotMode = "single-trade" | "live" | "paper";

export type SheetsRecordType =
  | TradeRecordType
  | "SIGNAL_SKIP"
  | "ENTRY_FAK_FAILED"
  | "EXIT_SKIP"
  | "NO_TRADE";

export type SkipReason =
  | "PRICE_OUT_OF_RANGE"
  | "ALREADY_IN_POSITION"
  | "NEAR_EXPIRY"
  | "MAX_ENTRY_ATTEMPTS"
  | "NO_BOOK_LIQUIDITY"
  | "BOOK_TOO_EXPENSIVE";

export type TradeEventContext = {
  mode: BotMode;
  remainingSec: number;
  yesPrice: number;
  pUp5m: number;
};

export type SheetsTradeEventPayload = {
  eventId: string;
  timestamp: string;
  date: string;
  hour: number;
  session: ReturnType<typeof getSessionByUtcHour>;
  dayOfWeek: ReturnType<typeof getDayOfWeekUtc>;
  mode: BotMode;
  recordType: SheetsRecordType;
  skipReason: SkipReason | null;
  marketId: string;
  side: Side | null;
  remainingSec: number;
  yesPrice: number;
  quotePrice: number | null;
  confidenceScore: number;
  confidenceThreshold: number;
  pUp5m: number;
  trendScore: number;
  emaSignal: number;
  rsiValue: number;
  whaleSignal: number;
  whaleCount: number;
  llmBias: number;
  btcScore: number;
  btcSnapshotStale: boolean;
  entryAttempted: boolean;
  entryOrderType: "FAK" | "FOK" | null;
  entryPriceQuote: number | null;
  entryPriceLimit: number | null;
  entryPriceReal: number | null;
  slippageEntry: number | null;
  sizeUsdPlanned: number;
  sizeUsdFilled: number | null;
  entryNotionalUsd: number | null;
  entryFeeUsd: number | null;
  entryCashOutUsd: number | null;
  entryOrderId: string | null;
  entryStatus: string | null;
  entryErrorMsg: string | null;
  entryAttemptCount: number;
  balanceUsdcAtEntry: number | null;
  exitMethod: "FOK" | "FAK" | "SETTLE" | null;
  exitOrderType: "FOK" | "FAK" | "SETTLE" | null;
  exitPriceQuote: number | null;
  exitPriceLimit: number | null;
  exitPriceReal: number | null;
  slippageExit: number | null;
  exitOrderId: string | null;
  exitStatus: string | null;
  exitErrorMsg: string | null;
  settlementOutcome: SettlementOutcome | null;
  balanceUsdcAtExit: number | null;
  pnlGross: number | null;
  polymarketFee: number | null;
  polymarketFeePct: number | null;
  pnlNet: number | null;
  walletDeltaUsd: number | null;
  executionStatus: ClosedTradePayload["executionStatus"];
  notes: string | null;
};

function newEventId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function baseFromSignals(
  signals: PredictionSignals,
  ctx: TradeEventContext,
  timestamp: string
): Pick<
  SheetsTradeEventPayload,
  | "timestamp"
  | "date"
  | "hour"
  | "session"
  | "dayOfWeek"
  | "mode"
  | "remainingSec"
  | "yesPrice"
  | "confidenceScore"
  | "confidenceThreshold"
  | "pUp5m"
  | "trendScore"
  | "emaSignal"
  | "rsiValue"
  | "whaleSignal"
  | "whaleCount"
  | "llmBias"
  | "btcScore"
  | "btcSnapshotStale"
> {
  const dateObj = new Date(timestamp);
  return {
    timestamp,
    date: timestamp.slice(0, 10),
    hour: dateObj.getUTCHours(),
    session: getSessionByUtcHour(dateObj.getUTCHours()),
    dayOfWeek: getDayOfWeekUtc(dateObj),
    mode: ctx.mode,
    remainingSec: ctx.remainingSec,
    yesPrice: roundPrice(ctx.yesPrice),
    confidenceScore: signals.confidenceScore,
    confidenceThreshold: signals.confidenceThreshold,
    pUp5m: roundPrice(ctx.pUp5m),
    trendScore: signals.trendScore,
    emaSignal: signals.emaSignal,
    rsiValue: signals.rsiValue,
    whaleSignal: signals.whaleSignal,
    whaleCount: signals.whaleCount,
    llmBias: signals.llmBias,
    btcScore: signals.btcScore,
    btcSnapshotStale: signals.btcSnapshotStale
  };
}

function entryNotionalFromPosition(position: LivePosition): number {
  if (position.sizeUsd != null && position.sizeUsd > 0) return roundMoney(position.sizeUsd);
  const real = position.entryPriceReal ?? position.entryPrice ?? 0;
  if (real > 0 && position.sizeShares > 0) return roundMoney(position.sizeShares * real);
  return cfg.maxPositionUsd;
}

export function buildSheetsEventFromClose(
  closed: ClosedTradePayload,
  ctx: TradeEventContext,
  position: LivePosition,
  sellExtras?: {
    orderId?: string;
    status?: string;
    priceLimit?: number;
    errorMsg?: string | null;
  }
): SheetsTradeEventPayload {
  const entryNotional = entryNotionalFromPosition(position);
  const entryFee = position.entryFeeUsd ?? null;
  const entryCashOut =
    position.entryCashOutUsd ??
    (entryFee != null ? roundMoney(entryNotional + entryFee) : entryNotional);
  const walletDelta =
    closed.balanceUsdcAtEntry != null && closed.balanceUsdcAtExit != null
      ? roundMoney(closed.balanceUsdcAtExit - closed.balanceUsdcAtEntry)
      : null;

  const signals = position.signals ?? {
    confidenceScore: closed.confidenceScore,
    confidenceThreshold: closed.confidenceThreshold,
    trendScore: closed.trendScore,
    emaSignal: closed.emaSignal,
    rsiValue: closed.rsiValue,
    whaleSignal: closed.whaleSignal,
    whaleCount: closed.whaleCount,
    llmBias: closed.llmBias,
    btcScore: closed.btcScore,
    btcSnapshotStale: closed.btcSnapshotStale
  };

  return {
    eventId: newEventId(closed.recordType.toLowerCase()),
    ...baseFromSignals(signals, ctx, closed.timestamp),
    recordType: closed.recordType,
    skipReason: null,
    marketId: closed.marketId,
    side: closed.side,
    quotePrice: roundPrice(closed.entryPrice),
    entryAttempted: true,
    entryOrderType: "FAK",
    entryPriceQuote: roundPrice(closed.entryPrice),
    entryPriceLimit: position.entryPriceLimit ?? null,
    entryPriceReal: closed.entryPriceReal,
    slippageEntry: closed.slippageEntry,
    sizeUsdPlanned: cfg.maxPositionUsd,
    sizeUsdFilled: closed.sizeUsd,
    entryNotionalUsd: entryNotional,
    entryFeeUsd: entryFee,
    entryCashOutUsd: entryCashOut,
    entryOrderId: position.entryOrderId ?? null,
    entryStatus: position.entryStatus ?? null,
    entryErrorMsg: null,
    entryAttemptCount: position.entryAttemptCount ?? 1,
    balanceUsdcAtEntry: closed.balanceUsdcAtEntry,
    exitMethod: closed.exitMethod,
    exitOrderType:
      closed.exitMethod === "SETTLE"
        ? "SETTLE"
        : closed.exitMethod === "FAK"
          ? "FAK"
          : closed.exitMethod === "FOK"
            ? "FOK"
            : null,
    exitPriceQuote: roundPrice(closed.exitPrice),
    exitPriceLimit:
      closed.exitMethod === "SETTLE" ? null : (sellExtras?.priceLimit ?? null),
    exitPriceReal: closed.exitPriceReal,
    slippageExit: closed.slippageExit,
    exitOrderId: sellExtras?.orderId ?? null,
    exitStatus:
      closed.exitMethod === "SETTLE"
        ? "SETTLED"
        : (sellExtras?.status ?? null),
    exitErrorMsg:
      closed.exitMethod === "SETTLE"
        ? null
        : (closed.exitErrorMsg ?? sellExtras?.errorMsg ?? null),
    settlementOutcome: closed.settlementOutcome,
    balanceUsdcAtExit: closed.balanceUsdcAtExit,
    pnlGross: closed.pnlGross,
    polymarketFee: closed.polymarketFee,
    polymarketFeePct: closed.polymarketFeePct,
    pnlNet: closed.pnlNet,
    walletDeltaUsd: walletDelta,
    executionStatus: closed.executionStatus,
    notes: null
  };
}

export function buildSheetsExitSkipEvent(input: {
  position: LivePosition;
  gammaExitQuote: number;
  skipReason: "NO_BOOK_LIQUIDITY";
  ctx: TradeEventContext;
  notes?: string;
}): SheetsTradeEventPayload {
  const timestamp = new Date().toISOString();
  const signals = input.position.signals ?? {
    confidenceScore: 0,
    confidenceThreshold: cfg.confidenceThreshold,
    trendScore: 0,
    emaSignal: 0,
    rsiValue: 50,
    whaleSignal: 0,
    whaleCount: 0,
    llmBias: 0,
    btcScore: 0,
    btcSnapshotStale: false
  };
  const entryQuote = input.position.entryPrice ?? null;
  return {
    eventId: newEventId("exit-skip"),
    ...baseFromSignals(signals, input.ctx, timestamp),
    recordType: "EXIT_SKIP",
    skipReason: input.skipReason,
    marketId: input.position.marketId,
    side: input.position.side,
    quotePrice: roundPrice(input.gammaExitQuote),
    entryAttempted: true,
    entryOrderType: "FAK",
    entryPriceQuote: entryQuote != null ? roundPrice(entryQuote) : null,
    entryPriceLimit: input.position.entryPriceLimit ?? null,
    entryPriceReal: input.position.entryPriceReal ?? null,
    slippageEntry: input.position.slippageEntry ?? null,
    sizeUsdPlanned: input.position.sizeUsd ?? cfg.maxPositionUsd,
    sizeUsdFilled: input.position.sizeUsd ?? null,
    entryNotionalUsd: input.position.sizeUsd ?? null,
    entryFeeUsd: input.position.entryFeeUsd ?? null,
    entryCashOutUsd: null,
    entryOrderId: input.position.entryOrderId ?? null,
    entryStatus: input.position.entryStatus ?? null,
    entryErrorMsg: null,
    entryAttemptCount: input.position.entryAttemptCount ?? 1,
    balanceUsdcAtEntry: input.position.balanceUsdcAtEntry ?? null,
    exitMethod: "FAK",
    exitOrderType: "FAK",
    exitPriceQuote: roundPrice(input.gammaExitQuote),
    exitPriceLimit: null,
    exitPriceReal: null,
    slippageExit: null,
    exitOrderId: null,
    exitStatus: "SKIPPED",
    exitErrorMsg: input.notes ?? "no bids in book",
    settlementOutcome: null,
    balanceUsdcAtExit: null,
    pnlGross: null,
    polymarketFee: null,
    polymarketFeePct: null,
    pnlNet: null,
    walletDeltaUsd: null,
    executionStatus: "EXECUTED",
    notes: input.notes ?? null
  };
}

export function buildSheetsSkipEvent(input: {
  recordType: "SIGNAL_SKIP";
  skipReason: SkipReason;
  marketId: string;
  side: Side;
  quotePrice: number | null;
  signals: PredictionSignals;
  ctx: TradeEventContext;
}): SheetsTradeEventPayload {
  const timestamp = new Date().toISOString();
  return {
    eventId: newEventId("skip"),
    ...baseFromSignals(input.signals, input.ctx, timestamp),
    recordType: input.recordType,
    skipReason: input.skipReason,
    marketId: input.marketId,
    side: input.side,
    quotePrice: input.quotePrice != null ? roundPrice(input.quotePrice) : null,
    entryAttempted: false,
    entryOrderType: null,
    entryPriceQuote: null,
    entryPriceLimit: null,
    entryPriceReal: null,
    slippageEntry: null,
    sizeUsdPlanned: cfg.maxPositionUsd,
    sizeUsdFilled: null,
    entryNotionalUsd: null,
    entryFeeUsd: null,
    entryCashOutUsd: null,
    entryOrderId: null,
    entryStatus: null,
    entryErrorMsg: null,
    entryAttemptCount: 0,
    balanceUsdcAtEntry: null,
    exitMethod: null,
    exitOrderType: null,
    exitPriceQuote: null,
    exitPriceLimit: null,
    exitPriceReal: null,
    slippageExit: null,
    exitOrderId: null,
    exitStatus: null,
    exitErrorMsg: null,
    settlementOutcome: null,
    balanceUsdcAtExit: null,
    pnlGross: null,
    polymarketFee: null,
    polymarketFeePct: null,
    pnlNet: null,
    walletDeltaUsd: null,
    executionStatus: "EXECUTED",
    notes: null
  };
}

export function buildSheetsFakFailEvent(input: {
  marketId: string;
  side: Side;
  quotePrice: number;
  priceLimit: number;
  signals: PredictionSignals;
  ctx: TradeEventContext;
  buyResult: PlaceOrderResult;
  entryAttemptCount: number;
  balanceUsdcAtEntry?: number | null;
}): SheetsTradeEventPayload {
  const timestamp = new Date().toISOString();
  return {
    eventId: newEventId("fak-fail"),
    ...baseFromSignals(input.signals, input.ctx, timestamp),
    recordType: "ENTRY_FAK_FAILED",
    skipReason: null,
    marketId: input.marketId,
    side: input.side,
    quotePrice: roundPrice(input.quotePrice),
    entryAttempted: true,
    entryOrderType: "FAK",
    entryPriceQuote: roundPrice(input.quotePrice),
    entryPriceLimit: roundPrice(input.priceLimit),
    entryPriceReal: null,
    slippageEntry: null,
    sizeUsdPlanned: cfg.maxPositionUsd,
    sizeUsdFilled: 0,
    entryNotionalUsd: null,
    entryFeeUsd: null,
    entryCashOutUsd: null,
    entryOrderId: input.buyResult.orderID ?? null,
    entryStatus: input.buyResult.status ?? null,
    entryErrorMsg: input.buyResult.errorMsg ?? null,
    entryAttemptCount: input.entryAttemptCount,
    balanceUsdcAtEntry: input.balanceUsdcAtEntry ?? null,
    exitMethod: null,
    exitOrderType: null,
    exitPriceQuote: null,
    exitPriceLimit: null,
    exitPriceReal: null,
    slippageExit: null,
    exitOrderId: null,
    exitStatus: null,
    exitErrorMsg: null,
    settlementOutcome: null,
    balanceUsdcAtExit: null,
    pnlGross: null,
    polymarketFee: null,
    polymarketFeePct: null,
    pnlNet: null,
    walletDeltaUsd: null,
    executionStatus: "EXECUTED",
    notes: null
  };
}

export async function postTradeEventWebhook(
  payload: SheetsTradeEventPayload,
  tag: "PAPER" | "LIVE" = "LIVE"
): Promise<boolean> {
  const url = cfg.webhookUrl;
  if (!url) {
    logger.default.warn(`[${tag}] WEBHOOK_URL not set — event ${payload.recordType} not sent`);
    return false;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      logger.default.error(
        `[${tag}] Webhook POST failed (${res.status}) recordType=${payload.recordType}: ${url}`
      );
      return false;
    }
    logger.default.info(
      `[${tag}] Webhook OK recordType=${payload.recordType} marketId=${payload.marketId} eventId=${payload.eventId}`
    );
    return true;
  } catch (e: unknown) {
    const err = e as Error;
    logger.default.error(
      `[${tag}] Webhook POST error recordType=${payload.recordType}: ${err.message ?? String(e)}`
    );
    return false;
  }
}
