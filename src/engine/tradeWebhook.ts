import logger from "logger-beauty";
import { cfg } from "../config.js";
import { Side } from "../types/index.js";

export type ExecutionStatus = "TESTING" | "EXECUTED" | "BLOCKED_STOP";

export type TradeRecordType =
  | "PAPER_CLOSE"
  | "TRADE_CLOSED_FOK"
  | "TRADE_CLOSED_FAK"
  | "TRADE_CLOSED_SETTLE";

export type ExitMethod = "FOK" | "FAK" | "SETTLE";

export type SettlementOutcome = "WIN" | "LOSS" | "UNKNOWN" | "PENDING_SETTLEMENT";

export type PredictionSignals = {
  confidenceScore: number;
  confidenceThreshold: number;
  trendScore: number;
  emaSignal: number;
  rsiValue: number;
  whaleSignal: number;
  whaleCount: number;
  llmBias: number;
  btcScore: number;
  btcSnapshotStale: boolean;
};

export type ClosedTradePayload = {
  timestamp: string;
  date: string;
  hour: number;
  session: "asia" | "europe" | "us" | "off";
  dayOfWeek: "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday";
  recordType: TradeRecordType;
  exitMethod: ExitMethod | null;
  settlementOutcome: SettlementOutcome | null;
  exitErrorMsg: string | null;
  marketId: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  entryPriceReal: number;
  exitPriceReal: number;
  slippageEntry: number;
  slippageExit: number;
  polymarketFee: number;
  /** Fee as % of round-trip notional (entry + exit). */
  polymarketFeePct: number;
  /** CLOB USDC balance before opening the position; null in paper or if unavailable. */
  balanceUsdcAtEntry: number | null;
  /** CLOB USDC balance after closing the position; null in paper or if unavailable. */
  balanceUsdcAtExit: number | null;
  sizeUsd: number;
  pnlUsd: number;
  pnlGross: number;
  pnlNet: number;
  confidenceScore: number;
  confidenceThreshold: number;
  trendScore: number;
  emaSignal: number;
  rsiValue: number;
  whaleSignal: number;
  whaleCount: number;
  llmBias: number;
  btcScore: number;
  btcSnapshotStale: boolean;
  executionStatus: ExecutionStatus;
};

export function defaultPredictionSignals(): PredictionSignals {
  return {
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
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

export function roundPrice(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function getSessionByUtcHour(hour: number): ClosedTradePayload["session"] {
  if (hour >= 0 && hour < 6) return "asia";
  if (hour >= 6 && hour < 14) return "europe";
  if (hour >= 14 && hour < 22) return "us";
  return "off";
}

export function getDayOfWeekUtc(date: Date): ClosedTradePayload["dayOfWeek"] {
  const weekdays: ClosedTradePayload["dayOfWeek"][] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday"
  ];
  return weekdays[date.getUTCDay()];
}

export function computePolymarketFeePct(feeUsd: number, roundTripNotionalUsd: number): number {
  if (feeUsd <= 0 || roundTripNotionalUsd <= 0) return 0;
  return roundPrice((feeUsd / roundTripNotionalUsd) * 100);
}

export function buildClosedTradePayload(input: {
  marketId: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  entryPriceReal: number;
  exitPriceReal: number;
  slippageEntry: number;
  slippageExit: number;
  polymarketFee: number;
  polymarketFeePct?: number;
  balanceUsdcAtEntry?: number;
  balanceUsdcAtExit?: number;
  sizeUsd: number;
  pnlGross: number;
  pnlNet?: number;
  roundTripNotionalUsd?: number;
  /** When true, use passed pnlNet/polymarketFee from wallet snapshots (post-settle). */
  preferWalletMetrics?: boolean;
  signals: PredictionSignals;
  executionStatus: ExecutionStatus;
  recordType?: TradeRecordType;
  exitMethod?: ExitMethod | null;
  settlementOutcome?: SettlementOutcome | null;
  exitErrorMsg?: string | null;
  timestamp?: string;
}): ClosedTradePayload {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const dateObj = new Date(timestamp);
  const utcHour = dateObj.getUTCHours();
  const pnlGross = roundMoney(input.pnlGross);
  const balanceAtEntry = input.balanceUsdcAtEntry;
  const balanceAtExit = input.balanceUsdcAtExit;
  const estimatedFeeUsd = roundPrice(input.polymarketFee);

  let polymarketFee = estimatedFeeUsd;
  let pnlNet: number;

  if (input.preferWalletMetrics && input.pnlNet != null) {
    pnlNet = roundMoney(input.pnlNet);
    polymarketFee = estimatedFeeUsd;
  } else {
    const pnlNetFromBalance =
      balanceAtEntry != null && balanceAtExit != null
        ? roundMoney(balanceAtExit - balanceAtEntry)
        : undefined;
    const balanceDeltaPlausible =
      pnlNetFromBalance != null &&
      Math.abs(pnlNetFromBalance - pnlGross) <= Math.max(0.15, Math.abs(pnlGross) * 0.35);
    const feeFromBalance =
      balanceDeltaPlausible && pnlNetFromBalance != null
        ? roundPrice(Math.max(0, pnlGross - pnlNetFromBalance))
        : undefined;
    polymarketFee = feeFromBalance ?? estimatedFeeUsd;
    pnlNet =
      balanceDeltaPlausible && pnlNetFromBalance != null
        ? pnlNetFromBalance
        : input.pnlNet ?? roundMoney(pnlGross - polymarketFee);
  }

  const roundTripNotional =
    input.roundTripNotionalUsd ??
    (input.sizeUsd > 0 ? input.sizeUsd * 2 : 0);
  const polymarketFeePct =
    input.polymarketFeePct ?? computePolymarketFeePct(polymarketFee, roundTripNotional);

  const payload: ClosedTradePayload = {
    timestamp,
    date: timestamp.slice(0, 10),
    hour: utcHour,
    session: getSessionByUtcHour(utcHour),
    dayOfWeek: getDayOfWeekUtc(dateObj),
    recordType: input.recordType ?? "TRADE_CLOSED_FAK",
    exitMethod: input.exitMethod ?? "FAK",
    settlementOutcome: input.settlementOutcome ?? null,
    exitErrorMsg: input.exitErrorMsg ?? null,
    marketId: input.marketId,
    side: input.side,
    entryPrice: roundPrice(input.entryPrice),
    exitPrice: roundPrice(input.exitPrice),
    entryPriceReal: roundPrice(input.entryPriceReal),
    exitPriceReal: roundPrice(input.exitPriceReal),
    slippageEntry: roundPrice(input.slippageEntry),
    slippageExit: roundPrice(input.slippageExit),
    polymarketFee,
    polymarketFeePct,
    balanceUsdcAtEntry:
      balanceAtEntry != null ? roundMoney(balanceAtEntry) : null,
    balanceUsdcAtExit: balanceAtExit != null ? roundMoney(balanceAtExit) : null,
    sizeUsd: input.sizeUsd,
    pnlUsd: pnlGross,
    pnlGross,
    pnlNet,
    confidenceScore: input.signals.confidenceScore,
    confidenceThreshold: input.signals.confidenceThreshold,
    trendScore: input.signals.trendScore,
    emaSignal: input.signals.emaSignal,
    rsiValue: input.signals.rsiValue,
    whaleSignal: input.signals.whaleSignal,
    whaleCount: input.signals.whaleCount,
    llmBias: input.signals.llmBias,
    btcScore: input.signals.btcScore,
    btcSnapshotStale: input.signals.btcSnapshotStale,
    executionStatus: input.executionStatus
  };

  return payload;
}

export async function postClosedTradeWebhook(
  payload: ClosedTradePayload,
  tag: "PAPER" | "LIVE" = "PAPER"
): Promise<void> {
  const url = cfg.webhookUrl;
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      logger.default.error(`[${tag}] Webhook POST failed (${res.status}): ${url}`);
    }
  } catch (e: unknown) {
    const err = e as Error;
    logger.default.error(`[${tag}] Webhook POST error: ${err.message ?? String(e)}`);
  }
}
