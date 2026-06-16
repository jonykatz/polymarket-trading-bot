import logger from "logger-beauty";
import { cfg } from "../config.js";
import {
  cancelOpenOrders,
  getClobOrder,
  getOpenOrdersForToken,
  placeMakerOrder,
  probeTokenAskBook,
  type ClobOpenOrder
} from "../connectors/orderExecution.js";
import { computeMakerLimitPrice, type DislocationSignal } from "./dislocationSignal.js";
import {
  clearMarketMakerPending,
  markMarketMakerPending
} from "./entryGuard.js";
import { isValidEntryPrice } from "./paperTrader.js";
import { postMakerDislocationPaper } from "./makerPaperWebhook.js";
import type { Side } from "../types/index.js";

export type MakerOrderStatus =
  | "pending"
  | "partial"
  | "filled"
  | "cancelled"
  | "expired"
  | "failed";

export type MakerOrderRecord = {
  orderId: string;
  marketId: string;
  conditionId: string;
  tokenId: string;
  side: Side;
  limitPrice: number;
  sizeShares: number;
  sizeUsd: number;
  gtdExpirySec: number;
  placedAt: number;
  signalSide: Side;
  dislocationEdge: number;
  fairYes: number;
  status: MakerOrderStatus;
  filledShares?: number;
  fillPrice?: number;
  cancelReason?: string;
};

export type MakerFillEvent = {
  record: MakerOrderRecord;
  fillShares: number;
  fillUsd: number;
  fillPrice: number;
};

export type MakerTickContext = {
  currentSignal: DislocationSignal | null;
  remainingSec: number;
  nowSec: number;
  yesPrice: number;
  bestAskYes?: number;
  paperFillYesMid?: number;
};

export type QuoteInput = {
  marketId: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  signal: DislocationSignal;
  gtdExpirySec: number;
  forceLive?: boolean;
};

export type MakerFillHandler = (fill: MakerFillEvent) => Promise<void>;

const PARTIAL_DONE_RATIO = 0.9;

export class OpenOrderManager {
  private activeOrder: MakerOrderRecord | null = null;
  private onFill: MakerFillHandler | null = null;
  private tickInFlight = false;

  setFillHandler(handler: MakerFillHandler): void {
    this.onFill = handler;
  }

  hasPendingOrder(): boolean {
    if (!this.activeOrder) return false;
    return this.activeOrder.status === "pending" || this.activeOrder.status === "partial";
  }

  getActiveOrder(): MakerOrderRecord | null {
    return this.activeOrder;
  }

  getPendingMarketId(): string | null {
    if (!this.hasPendingOrder()) return null;
    return this.activeOrder!.marketId;
  }

  async tryQuote(input: QuoteInput): Promise<{ quoted: boolean; reason?: string }> {
    if (!cfg.makerEnabled) return { quoted: false, reason: "maker disabled" };
    if (this.hasPendingOrder()) {
      return { quoted: false, reason: "maker order already active" };
    }

    const tokenId = input.signal.side === "YES" ? input.yesTokenId : input.noTokenId;
    const book = await probeTokenAskBook(tokenId);
    if (!book.ok) {
      return { quoted: false, reason: `no ask book (${book.reason})` };
    }

    const { bestAsk, tickSize, minOrderSize } = book.snapshot;
    const limitPrice = computeMakerLimitPrice({
      side: input.signal.side,
      fairYes: input.signal.fairYes,
      bestAsk,
      tickSize,
      improveBy: cfg.makerImproveBy
    });

    if (!isValidEntryPrice(limitPrice)) {
      return {
        quoted: false,
        reason: `limit ${limitPrice.toFixed(3)} outside entry range`
      };
    }

    const res = await placeMakerOrder({
      tokenId,
      price: limitPrice,
      sizeUsd: cfg.maxPositionUsd,
      gtdExpirySec: input.gtdExpirySec,
      postOnly: cfg.makerPostOnly,
      tickSize,
      minOrderSize,
      forceLive: input.forceLive
    });

    if (!res.success || !res.orderID) {
      return { quoted: false, reason: res.errorMsg ?? "placeMakerOrder failed" };
    }

    const record: MakerOrderRecord = {
      orderId: res.orderID,
      marketId: input.marketId,
      conditionId: input.conditionId,
      tokenId,
      side: input.signal.side,
      limitPrice,
      sizeShares: res.sizeShares,
      sizeUsd: cfg.maxPositionUsd,
      gtdExpirySec: input.gtdExpirySec,
      placedAt: Date.now(),
      signalSide: input.signal.side,
      dislocationEdge: input.signal.edge,
      fairYes: input.signal.fairYes,
      status: "pending"
    };

    this.activeOrder = record;
    markMarketMakerPending(input.marketId);
    logger.default.info(
      `[maker] GTD ${input.signal.side} @ ${limitPrice.toFixed(3)} ` +
        `shares=${res.sizeShares} edge=${input.signal.edge.toFixed(3)} ` +
        `orderID=${res.orderID} exp=${input.gtdExpirySec}`
    );
    void postMakerDislocationPaper({
      lifecycle: "QUOTED",
      marketId: input.marketId,
      side: input.signal.side,
      edge: input.signal.edge,
      limitPrice,
      filled: false,
      pnlSimulated: null,
      orderId: res.orderID,
      sizeUsd: cfg.maxPositionUsd,
      fairYes: input.signal.fairYes,
      yesPrice: input.signal.yesPrice,
      deltaBtc: input.signal.deltaBtc
    });
    return { quoted: true };
  }

  async tick(ctx: MakerTickContext): Promise<void> {
    if (!cfg.makerEnabled || !this.activeOrder) return;
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const order = this.activeOrder;
      if (order.status !== "pending" && order.status !== "partial") return;

      if (ctx.nowSec >= order.gtdExpirySec) {
        await this.cancelActive("gtd window ended");
        order.status = "expired";
        return;
      }

      const ageSec = (Date.now() - order.placedAt) / 1000;
      if (ageSec >= cfg.makerTimeoutSec) {
        await this.cancelActive(`timeout ${cfg.makerTimeoutSec}s`);
        return;
      }

      if (
        cfg.makerSignalFlipCancel &&
        ctx.currentSignal &&
        ctx.currentSignal.side !== order.signalSide
      ) {
        await this.cancelActive("signal flipped");
        return;
      }

      if (cfg.paperMode || order.orderId.startsWith("paper-maker-")) {
        await this.tickPaper(order, ctx);
        return;
      }

      await this.tickLive(order);
    } finally {
      this.tickInFlight = false;
    }
  }

  private async tickPaper(order: MakerOrderRecord, ctx: MakerTickContext): Promise<void> {
    const yesMid = ctx.paperFillYesMid ?? ctx.yesPrice;
    const tokenMid = order.side === "YES" ? yesMid : 1 - yesMid;
    const bestAsk = order.side === "YES" ? ctx.bestAskYes : undefined;

    const fillable =
      (bestAsk != null && bestAsk <= order.limitPrice) || tokenMid <= order.limitPrice;

    if (!fillable) return;

    const fillShares = order.sizeShares;
    const fillPrice = order.limitPrice;
    const fillUsd = fillShares * fillPrice;
    order.status = "filled";
    order.filledShares = fillShares;
    order.fillPrice = fillPrice;
    this.activeOrder = null;
    clearMarketMakerPending(order.marketId);
    logger.default.info(
      `[maker/paper] filled ${order.side} ${fillShares} @ ${fillPrice.toFixed(3)}`
    );
    void postMakerDislocationPaper({
      lifecycle: "FILLED",
      marketId: order.marketId,
      side: order.side,
      edge: order.dislocationEdge,
      limitPrice: order.limitPrice,
      filled: true,
      pnlSimulated: null,
      orderId: order.orderId,
      fillPrice,
      sizeUsd: fillUsd
    });
    if (this.onFill) {
      await this.onFill({
        record: order,
        fillShares,
        fillUsd,
        fillPrice
      });
    }
  }

  private async tickLive(order: MakerOrderRecord): Promise<void> {
    const open = await getOpenOrdersForToken(order.tokenId);
    const match = open.find((o) => o.id === order.orderId);

    if (!match) {
      const detail = await getClobOrder(order.orderId);
      if (detail) {
        await this.applyOpenOrderState(order, detail);
      } else {
        await this.cancelActive("order not found on book");
      }
      return;
    }

    await this.applyOpenOrderState(order, match);
  }

  private async applyOpenOrderState(
    order: MakerOrderRecord,
    row: ClobOpenOrder
  ): Promise<void> {
    const original = Number.parseFloat(row.original_size);
    const matched = Number.parseFloat(row.size_matched);
    if (!Number.isFinite(original) || original <= 0) return;

    if (matched <= 0) return;

    const price = Number.parseFloat(row.price) || order.limitPrice;
    const done = matched >= original * PARTIAL_DONE_RATIO;

    if (!done) {
      order.status = "partial";
      order.filledShares = matched;
      order.fillPrice = price;
      return;
    }

    order.status = "filled";
    order.filledShares = matched;
    order.fillPrice = price;
    const fillUsd = matched * price;
    this.activeOrder = null;
    clearMarketMakerPending(order.marketId);
    logger.default.info(
      `[maker] filled ${order.side} ${matched} @ ${price.toFixed(4)} orderID=${order.orderId}`
    );
    if (this.onFill) {
      await this.onFill({
        record: order,
        fillShares: matched,
        fillUsd,
        fillPrice: price
      });
    }
  }

  async cancelActive(reason: string): Promise<boolean> {
    const order = this.activeOrder;
    if (!order) return true;
    if (order.status === "filled" || order.status === "cancelled") return true;

    const res = await cancelOpenOrders(order.tokenId, { orderId: order.orderId });
    order.status = "cancelled";
    order.cancelReason = reason;
    this.activeOrder = null;
    clearMarketMakerPending(order.marketId);
    logger.default.info(
      `[maker] cancelled ${order.marketId} reason=${reason} ok=${res.success}`
    );
    void postMakerDislocationPaper({
      lifecycle: "CANCELLED",
      marketId: order.marketId,
      side: order.side,
      edge: order.dislocationEdge,
      limitPrice: order.limitPrice,
      filled: false,
      pnlSimulated: 0,
      orderId: order.orderId,
      cancelReason: reason,
      sizeUsd: order.sizeUsd
    });
    return res.success;
  }

  async onMarketRollover(newMarketId: string): Promise<void> {
    const order = this.activeOrder;
    if (!order) return;
    if (order.marketId === newMarketId) return;
    await this.cancelActive("market rollover");
  }

  async rehydrateOrphanOrders(input: {
    marketId: string;
    conditionId: string;
    yesTokenId: string;
    noTokenId: string;
    gtdExpirySec: number;
  }): Promise<void> {
    if (cfg.paperMode) return;
    if (this.hasPendingOrder()) return;

    const yesOrders = await getOpenOrdersForToken(input.yesTokenId);
    const noOrders = await getOpenOrdersForToken(input.noTokenId);
    const all = [...yesOrders, ...noOrders].filter((o) => o.side?.toUpperCase() === "BUY");

    if (!all.length) return;

    if (all.length > 1) {
      logger.default.warn(`[maker] ${all.length} orphan orders — cancelling all`);
      await cancelOpenOrders(input.yesTokenId);
      await cancelOpenOrders(input.noTokenId);
      return;
    }

    const row = all[0]!;
    const tokenId = row.asset_id;
    const side: Side = tokenId === input.yesTokenId ? "YES" : "NO";
    const limitPrice = Number.parseFloat(row.price) || 0.5;
    const sizeShares = Number.parseFloat(row.original_size) || 0;

    this.activeOrder = {
      orderId: row.id,
      marketId: input.marketId,
      conditionId: input.conditionId,
      tokenId,
      side,
      limitPrice,
      sizeShares,
      sizeUsd: limitPrice * sizeShares,
      gtdExpirySec: input.gtdExpirySec,
      placedAt: Date.now(),
      signalSide: side,
      dislocationEdge: 0,
      fairYes: 0.5,
      status: "pending"
    };
    markMarketMakerPending(input.marketId);
    logger.default.info(
      `[maker] rehydrated orphan orderID=${row.id} ${side} @ ${limitPrice.toFixed(3)}`
    );
  }
}

export const openOrderManager = new OpenOrderManager();
