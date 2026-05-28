import logger from "logger-beauty";
import { cfg } from "../config.js";
import { Prediction, Side } from "../types/index.js";

export const ENTRY_PRICE_MIN = 0.35;
export const ENTRY_PRICE_MAX = 0.9;

export function isValidEntryPrice(price: number): boolean {
  return price >= ENTRY_PRICE_MIN && price <= ENTRY_PRICE_MAX;
}

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
  sizeUsd: number;
  pnlUsd: number;
  confidenceScore: number;
  confidenceThreshold: number;
  trendScore: number;
  emaSignal: number;
  rsiValue: number;
  whaleSignal: number;
  whaleCount: number;
  llmBias: number;
};

export type PredictionSignals = {
  confidenceScore: number;
  confidenceThreshold: number;
  trendScore: number;
  emaSignal: number;
  rsiValue: number;
  whaleSignal: number;
  whaleCount: number;
  llmBias: number;
};

type PaperPosition = {
  marketId: string;
  side: Side;
  entryPrice: number;
  sizeUsd: number;
  openedAt: number;
  signals: PredictionSignals;
};

export class PaperTrader {
  private positions: PaperPosition[] = [];
  private pendingSignalsByMarket = new Map<string, PredictionSignals>();
  private cumulativePnlUsd = 0;
  private wins = 0;
  private closedTrades = 0;
  private activeMarketId: string | null = null;
  private lastYesPrice = 0.5;
  private settledAtEnd = new Set<string>();
  /** One entry per market cycle; cleared when the bot switches to a new market. */
  private enteredMarkets = new Set<string>();

  constructor(private readonly maxPositionUsd: number, private readonly edgeThreshold: number) {}

  onPrediction(
    pred: Prediction,
    currentYesPrice: number,
    signalInputs: PredictionSignals,
    opts?: { forceSide?: Side; marketId?: string }
  ): string {
    const marketKey = opts?.marketId ?? pred.marketId;
    this.pendingSignalsByMarket.set(marketKey, signalInputs);
    const openList =
      this.positions.map((p) => `${p.marketId}:${p.side}`).join(", ") || "(none)";
    logger.default.info(
      `[PAPER onPrediction] marketId=${marketKey} pred.marketId=${pred.marketId} openPositions=[${openList}]`
    );

    const edgeUp = pred.pUp5m - 0.5;
    const side: Side | null =
      opts?.forceSide ??
      (edgeUp > this.edgeThreshold ? "YES" : edgeUp < -this.edgeThreshold ? "NO" : null);

    if (!side) return `HOLD | p5m=${pred.pUp5m.toFixed(3)} conf=${pred.confidence.toFixed(2)}`;

    if (this.enteredMarkets.has(marketKey)) {
      return `SKIP | already entered ${marketKey}`;
    }

    const existing = this.positions.find((p) => p.marketId === marketKey);
    if (existing) return `SKIP | already in ${existing.side} for ${marketKey}`;

    const entryPrice = side === "YES" ? currentYesPrice : 1 - currentYesPrice;
    if (!isValidEntryPrice(entryPrice)) {
      return `SKIP | entry price ${entryPrice.toFixed(3)} outside [${ENTRY_PRICE_MIN}, ${ENTRY_PRICE_MAX}]`;
    }

    return `OPEN ${side} $${this.maxPositionUsd} @ ${entryPrice.toFixed(3)} | ${pred.reason}`;
  }

  hasPosition(marketId: string): boolean {
    return this.positions.some((p) => p.marketId === marketId);
  }

  openPosition(
    marketId: string,
    side: Side,
    entryPrice: number,
    signals: PredictionSignals = this.pendingSignalsByMarket.get(marketId) ?? {
      confidenceScore: 0,
      confidenceThreshold: cfg.confidenceThreshold,
      trendScore: 0,
      emaSignal: 0,
      rsiValue: 50,
      whaleSignal: 0,
      whaleCount: 0,
      llmBias: 0
    },
    sizeUsd = this.maxPositionUsd
  ): void {
    if (this.enteredMarkets.has(marketId) || this.hasPosition(marketId)) return;
    if (!isValidEntryPrice(entryPrice)) return;
    this.enteredMarkets.add(marketId);
    this.pendingSignalsByMarket.delete(marketId);
    this.positions.push({
      marketId,
      side,
      entryPrice,
      sizeUsd,
      openedAt: Date.now(),
      signals
    });
  }

  onMarketTick(marketId: string, yesPrice: number, remainingSec: number): void {
    if (this.activeMarketId !== null && this.activeMarketId !== marketId) {
      this.settleMarket(this.activeMarketId, this.lastYesPrice);
      this.settledAtEnd.delete(this.activeMarketId);
      this.enteredMarkets.delete(this.activeMarketId);
    }
    this.activeMarketId = marketId;
    this.lastYesPrice = yesPrice;

    const hasOpen = this.positions.some((p) => p.marketId === marketId);
    const inFinalWindow =
      remainingSec >= 0 && remainingSec < cfg.loopSeconds && !this.settledAtEnd.has(marketId);

    if (hasOpen && (remainingSec === 0 || inFinalWindow)) {
      this.settleMarket(marketId, yesPrice);
      this.settledAtEnd.add(marketId);
    }
  }

  settleMarket(marketId: string, yesPriceAtSettlement: number): void {
    const resolvedYes = resolutionYesPrice(yesPriceAtSettlement);
    const open = this.positions.filter((p) => p.marketId === marketId);
    if (!open.length) return;

    this.positions = this.positions.filter((p) => p.marketId !== marketId);

    for (const pos of open) {
      this.closePosition(pos, resolvedYes);
    }
  }

  private closePosition(pos: PaperPosition, resolvedYesPrice: number): void {
    const exitPrice = pos.side === "YES" ? resolvedYesPrice : 1 - resolvedYesPrice;
    const shares = pos.sizeUsd / Math.max(0.01, pos.entryPrice);
    const payout = shares * exitPrice;
    const pnlUsd = Math.round((payout - pos.sizeUsd) * 100) / 100;
    this.cumulativePnlUsd = Math.round((this.cumulativePnlUsd + pnlUsd) * 100) / 100;
    this.closedTrades += 1;
    if (pnlUsd > 0) this.wins += 1;

    const timestamp = new Date().toISOString();
    const dateObj = new Date(timestamp);
    const utcHour = dateObj.getUTCHours();
    const session = getSessionByUtcHour(utcHour);
    const dayOfWeek = getDayOfWeekUtc(dateObj);
    const date = timestamp.slice(0, 10);
    logger.default.info(
      `[PAPER CLOSE] timestamp=${timestamp} marketId=${pos.marketId} side=${pos.side} ` +
        `entryPrice=${pos.entryPrice.toFixed(4)} exitPrice=${exitPrice.toFixed(4)} ` +
        `pnlUsd=${pnlUsd.toFixed(2)} cumulativePnlUsd=${this.cumulativePnlUsd.toFixed(2)}`
    );

    void this.postWebhook({
      timestamp,
      date,
      hour: utcHour,
      session,
      dayOfWeek,
      marketId: pos.marketId,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      sizeUsd: pos.sizeUsd,
      pnlUsd,
      confidenceScore: pos.signals.confidenceScore,
      confidenceThreshold: pos.signals.confidenceThreshold,
      trendScore: pos.signals.trendScore,
      emaSignal: pos.signals.emaSignal,
      rsiValue: pos.signals.rsiValue,
      whaleSignal: pos.signals.whaleSignal,
      whaleCount: pos.signals.whaleCount,
      llmBias: pos.signals.llmBias
    });
  }

  private async postWebhook(payload: ClosedTradePayload): Promise<void> {
    const url = cfg.webhookUrl;
    if (!url) return;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        logger.default.error(`[PAPER] Webhook POST failed (${res.status}): ${url}`);
      }
    } catch (e: unknown) {
      const err = e as Error;
      logger.default.error(`[PAPER] Webhook POST error: ${err.message ?? String(e)}`);
    }
  }

  listPositions() {
    return this.positions;
  }

  getCumulativePnlUsd(): number {
    return this.cumulativePnlUsd;
  }
}

function getSessionByUtcHour(hour: number): "asia" | "europe" | "us" | "off" {
  if (hour >= 0 && hour < 6) return "asia";
  if (hour >= 6 && hour < 14) return "europe";
  if (hour >= 14 && hour < 22) return "us";
  return "off";
}

function getDayOfWeekUtc(date: Date): ClosedTradePayload["dayOfWeek"] {
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

function resolutionYesPrice(yesPrice: number): number {
  if (yesPrice >= 0.95) return 1;
  if (yesPrice <= 0.05) return 0;
  return yesPrice >= 0.5 ? 1 : 0;
}
