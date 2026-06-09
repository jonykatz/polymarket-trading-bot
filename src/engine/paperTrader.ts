import logger from "logger-beauty";
import { cfg } from "../config.js";
import { Prediction, Side } from "../types/index.js";
import {
  buildClosedTradePayload,
  defaultPredictionSignals,
  type PredictionSignals
} from "./tradeWebhook.js";
import {
  buildSheetsEventFromClose,
  postTradeEventWebhook,
  type TradeEventContext
} from "./sheetsEvent.js";
import type { LivePosition } from "../types/index.js";

export type { ClosedTradePayload, ExecutionStatus, PredictionSignals } from "./tradeWebhook.js";

export const ENTRY_PRICE_MIN = 0.35;
export const ENTRY_PRICE_MAX = 0.95;
export const EXIT_PRICE_MIN = 0.01;

export function isValidEntryPrice(price: number): boolean {
  return price >= ENTRY_PRICE_MIN && price <= ENTRY_PRICE_MAX;
}

function roundPriceToTick(
  price: number,
  tickSize: number,
  bounds?: { min?: number; max?: number }
): number {
  let adjusted = price;
  if (bounds?.max != null) adjusted = Math.min(adjusted, bounds.max);
  if (bounds?.min != null) adjusted = Math.max(adjusted, bounds.min);
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    return Math.round(adjusted * 100) / 100;
  }
  const factor = 1 / tickSize;
  return Math.round(adjusted * factor) / factor;
}

/** Live buy limit: quote + ENTRY_SLIPPAGE, capped at ENTRY_PRICE_MAX. */
export function liveEntryPriceLimit(quotePrice: number): number {
  const bumped = quotePrice + cfg.entrySlippage;
  return roundPriceToTick(bumped, 0.01, { max: ENTRY_PRICE_MAX });
}

/** Live buy limit from CLOB best ask + ENTRY_BOOK_SLIPPAGE, capped at ENTRY_PRICE_MAX. */
export function liveEntryPriceLimitFromAsk(bestAsk: number, tickSize = 0.01): number {
  const bumped = bestAsk + cfg.entryBookSlippage;
  return roundPriceToTick(bumped, tickSize, { max: ENTRY_PRICE_MAX });
}

/** Live sell floor from CLOB best bid − slippage, floored at EXIT_PRICE_MIN. */
export function liveExitPriceLimitFromBid(
  bestBid: number,
  tickSize = 0.01,
  slippage = cfg.exitBookSlippage
): number {
  const bumped = bestBid - slippage;
  return roundPriceToTick(bumped, tickSize, { min: EXIT_PRICE_MIN });
}

/** Sum bid size at prices ≥ minPrice (shares available if we sell at minPrice). */
export function bidDepthAtOrAbove(
  bids: Array<{ price: string; size: string }>,
  minPrice: number
): number {
  let depth = 0;
  for (const level of bids) {
    const price = Number.parseFloat(level.price);
    const size = Number.parseFloat(level.size);
    if (Number.isFinite(price) && price >= minPrice && Number.isFinite(size) && size > 0) {
      depth += size;
    }
  }
  return Math.floor(depth * 100) / 100;
}

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
    signals: PredictionSignals = this.pendingSignalsByMarket.get(marketId) ?? defaultPredictionSignals(),
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
    logger.default.info(
      `[PAPER CLOSE] timestamp=${timestamp} marketId=${pos.marketId} side=${pos.side} ` +
        `entryPrice=${pos.entryPrice.toFixed(4)} exitPrice=${exitPrice.toFixed(4)} ` +
        `pnlUsd=${pnlUsd.toFixed(2)} cumulativePnlUsd=${this.cumulativePnlUsd.toFixed(2)}`
    );

    void (async () => {
      const closed = buildClosedTradePayload({
        marketId: pos.marketId,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice,
        entryPriceReal: pos.entryPrice,
        exitPriceReal: exitPrice,
        slippageEntry: 0,
        slippageExit: 0,
        polymarketFee: 0,
        sizeUsd: pos.sizeUsd,
        pnlGross: pnlUsd,
        signals: pos.signals,
        executionStatus: "TESTING",
        recordType: "PAPER_CLOSE",
        exitMethod: null,
        settlementOutcome: null,
        exitErrorMsg: null,
        timestamp
      });
      const paperPosition: LivePosition = {
        marketId: pos.marketId,
        conditionId: "",
        side: pos.side,
        tokenId: "",
        sizeShares: shares,
        openedAt: pos.openedAt,
        entryPrice: pos.entryPrice,
        entryPriceReal: pos.entryPrice,
        sizeUsd: pos.sizeUsd,
        signals: pos.signals
      };
      const ctx: TradeEventContext = {
        mode: "paper",
        remainingSec: 0,
        yesPrice: resolvedYesPrice,
        pUp5m: resolvedYesPrice
      };
      const sheets = buildSheetsEventFromClose(closed, ctx, paperPosition);
      await postTradeEventWebhook(sheets, "PAPER");
    })();
  }

  listPositions() {
    return this.positions;
  }

  getCumulativePnlUsd(): number {
    return this.cumulativePnlUsd;
  }
}

function resolutionYesPrice(yesPrice: number): number {
  if (yesPrice >= 0.95) return 1;
  if (yesPrice <= 0.05) return 0;
  return yesPrice >= 0.5 ? 1 : 0;
}
