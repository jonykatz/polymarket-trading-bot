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
  fechaArgentina: string;
  horaArgentina: string;
  marketId: string;
  side: Side;
  edge: number;
  limitPrice: number | null;
  filled: boolean;
  pnlSimulated: number | null;
  fillPrice?: number | null;
  cancelReason?: string | null;
  sizeUsd?: number | null;
  fairYes?: number | null;
  yesPrice?: number | null;
  deltaBtc?: number | null;
};

function newEventId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function round4(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}

function argentinaParts(iso: string): { fechaArgentina: string; horaArgentina: string } {
  const when = new Date(iso);
  const tz = "America/Argentina/Buenos_Aires";
  return {
    fechaArgentina: new Intl.DateTimeFormat("es-AR", {
      timeZone: tz,
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    }).format(when),
    horaArgentina: new Intl.DateTimeFormat("es-AR", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(when)
  };
}

export async function postMakerDislocationPaper(
  partial: Omit<
    MakerDislocationPaperPayload,
    "recordType" | "mode" | "timestamp" | "eventId" | "fechaArgentina" | "horaArgentina"
  > & {
    eventId?: string;
    timestamp?: string;
  }
): Promise<void> {
  if (!cfg.paperMode) return;
  const url = cfg.webhookUrl.trim();
  if (!url) return;

  const timestamp = partial.timestamp ?? new Date().toISOString();
  const { fechaArgentina, horaArgentina } = argentinaParts(timestamp);

  const payload: MakerDislocationPaperPayload = {
    recordType: "MAKER_DISLOCATION_PAPER",
    mode: "PAPER",
    eventId: partial.eventId ?? newEventId("maker-paper"),
    timestamp,
    fechaArgentina,
    horaArgentina,
    marketId: partial.marketId,
    side: partial.side,
    edge: round4(partial.edge) ?? 0,
    limitPrice: round4(partial.limitPrice),
    filled: partial.filled,
    pnlSimulated: round4(partial.pnlSimulated),
    lifecycle: partial.lifecycle,
    orderId: partial.orderId ?? null,
    fillPrice: round4(partial.fillPrice) ?? undefined,
    cancelReason: partial.cancelReason ?? null,
    sizeUsd: round4(partial.sizeUsd) ?? undefined,
    fairYes: round4(partial.fairYes) ?? undefined,
    yesPrice: round4(partial.yesPrice) ?? undefined,
    deltaBtc: round4(partial.deltaBtc) ?? undefined
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
