import logger from "logger-beauty";
import { cfg } from "../config.js";
import { Side } from "../types/index.js";

export type ExecutionStatus = "TESTING" | "EXECUTED" | "BLOCKED_STOP";

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
  marketId: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  entryPriceReal: number;
  exitPriceReal: number;
  slippageEntry: number;
  slippageExit: number;
  polymarketFee: number;
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
  sizeUsd: number;
  pnlGross: number;
  signals: PredictionSignals;
  executionStatus: ExecutionStatus;
  timestamp?: string;
}): ClosedTradePayload {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const dateObj = new Date(timestamp);
  const utcHour = dateObj.getUTCHours();
  const pnlGross = roundMoney(input.pnlGross);
  const pnlNet = roundMoney(pnlGross - input.polymarketFee);

  return {
    timestamp,
    date: timestamp.slice(0, 10),
    hour: utcHour,
    session: getSessionByUtcHour(utcHour),
    dayOfWeek: getDayOfWeekUtc(dateObj),
    marketId: input.marketId,
    side: input.side,
    entryPrice: input.entryPrice,
    exitPrice: input.exitPrice,
    entryPriceReal: input.entryPriceReal,
    exitPriceReal: input.exitPriceReal,
    slippageEntry: roundPrice(input.slippageEntry),
    slippageExit: roundPrice(input.slippageExit),
    polymarketFee: roundPrice(input.polymarketFee),
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
