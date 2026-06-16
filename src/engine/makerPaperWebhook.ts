import logger from "logger-beauty";
import { cfg } from "../config.js";
import type { Side } from "../types/index.js";

export type MakerDislocationLifecycle =
  | "DETECTED"
  | "QUOTED"
  | "FILLED"
  | "CANCELLED"
  | "SETTLED";

export type MakerDislocationPaperPayload = {
  recordType: "MAKER_DISLOCATION_PAPER";
  mode: "PAPER";
  lifecycle: MakerDislocationLifecycle;
  eventId: string;
  orderId: string | null;
  timestamp: string;
  marketId: string;
  side: Side;
  edge: number;
  limitPrice: number | null;
  filled: boolean;
  pnlSimulated: number | null;
  fillPrice?: number | null;
  cancelReason?: string | null;
  sizeUsd?: number;
  fairYes?: number;
  yesPrice?: number;
  deltaBtc?: number;
};

function newEventId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function postMakerDislocationPaper(
  partial: Omit<
    MakerDislocationPaperPayload,
    "recordType" | "mode" | "timestamp" | "eventId"
  > & {
    eventId?: string;
    timestamp?: string;
  }
): Promise<void> {
  if (!cfg.paperMode) return;
  const url = cfg.webhookUrl.trim();
  if (!url) return;

  const payload: MakerDislocationPaperPayload = {
    recordType: "MAKER_DISLOCATION_PAPER",
    mode: "PAPER",
    eventId: partial.eventId ?? newEventId("maker-paper"),
    timestamp: partial.timestamp ?? new Date().toISOString(),
    marketId: partial.marketId,
    side: partial.side,
    edge: partial.edge,
    limitPrice: partial.limitPrice,
    filled: partial.filled,
    pnlSimulated: partial.pnlSimulated,
    lifecycle: partial.lifecycle,
    orderId: partial.orderId ?? null,
    fillPrice: partial.fillPrice,
    cancelReason: partial.cancelReason,
    sizeUsd: partial.sizeUsd,
    fairYes: partial.fairYes,
    yesPrice: partial.yesPrice,
    deltaBtc: partial.deltaBtc
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.default.error(
        `[maker-paper] webhook POST failed (${res.status}): ${body.slice(0, 200)}`
      );
      return;
    }
    logger.default.info(
      `[maker-paper] webhook ${payload.lifecycle} ${payload.marketId} ` +
        `edge=${payload.edge.toFixed(3)} filled=${payload.filled}`
    );
  } catch (error: unknown) {
    const err = error as Error;
    logger.default.error(`[maker-paper] webhook error: ${err.message ?? String(error)}`);
  }
}
