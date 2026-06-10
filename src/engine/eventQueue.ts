import fs from "node:fs";
import path from "node:path";
import type { PlaceOrderResult } from "../connectors/orderExecution.js";
import type { LivePosition } from "../types/index.js";
import type { SheetsTradeEventPayload, TradeEventContext } from "./sheetsEvent.js";

const dataDir = path.join(process.cwd(), ".data");
const queuePath = path.join(dataDir, "event-queue.jsonl");
const statePath = path.join(dataDir, "event-queue-state.json");

export type QueuedCloseSettleEvent = {
  kind: "CLOSE_SETTLE";
  id: string;
  enqueuedAt: number;
  position: LivePosition;
  eventContext: TradeEventContext;
  gammaResolvedYesPrice: number | null;
  sellPriceLimit?: number;
  assumeTotalLossHint?: boolean;
  balanceUsdcBeforeExit?: number;
};

export type QueuedCloseFakEvent = {
  kind: "CLOSE_FAK";
  id: string;
  enqueuedAt: number;
  position: LivePosition;
  eventContext: TradeEventContext;
  exitQuotePrice: number;
  sellResult: PlaceOrderResult;
  sellPriceLimit?: number;
  balanceUsdcBeforeExit?: number;
};

export type QueuedSheetsEvent = {
  kind: "SHEETS";
  id: string;
  enqueuedAt: number;
  dedupeKey?: string;
  payload: SheetsTradeEventPayload;
  tag: "PAPER" | "LIVE";
};

export type QueuedReportingEvent =
  | QueuedCloseSettleEvent
  | QueuedCloseFakEvent
  | QueuedSheetsEvent;

export type EnqueueReportingInput =
  | (Omit<QueuedCloseSettleEvent, "id" | "enqueuedAt"> & { id?: string; enqueuedAt?: number })
  | (Omit<QueuedCloseFakEvent, "id" | "enqueuedAt"> & { id?: string; enqueuedAt?: number })
  | (Omit<QueuedSheetsEvent, "id" | "enqueuedAt"> & { id?: string; enqueuedAt?: number });

type QueueState = {
  processed: string[];
  failed: Record<string, number>;
};

function ensureDataDir(): void {
  fs.mkdirSync(dataDir, { recursive: true });
}

function newEventId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function loadState(): QueueState {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const data = JSON.parse(raw) as Partial<QueueState>;
    return {
      processed: Array.isArray(data.processed) ? data.processed : [],
      failed: data.failed && typeof data.failed === "object" ? data.failed : {}
    };
  } catch {
    return { processed: [], failed: {} };
  }
}

function saveState(state: QueueState): void {
  ensureDataDir();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

function readAllEvents(): QueuedReportingEvent[] {
  ensureDataDir();
  if (!fs.existsSync(queuePath)) return [];
  const raw = fs.readFileSync(queuePath, "utf-8");
  const events: QueuedReportingEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as QueuedReportingEvent);
    } catch {
      // skip corrupt lines
    }
  }
  return events;
}

export function enqueueEvent(event: EnqueueReportingInput): QueuedReportingEvent {
  ensureDataDir();
  const full = {
    ...event,
    id: event.id ?? newEventId(event.kind.toLowerCase()),
    enqueuedAt: event.enqueuedAt ?? Date.now()
  } as QueuedReportingEvent;
  fs.appendFileSync(queuePath, `${JSON.stringify(full)}\n`, "utf-8");
  return full;
}

export function markEventProcessed(id: string): void {
  const state = loadState();
  if (!state.processed.includes(id)) {
    state.processed.push(id);
  }
  delete state.failed[id];
  saveState(state);
}

export function markEventFailed(id: string): number {
  const state = loadState();
  const retries = (state.failed[id] ?? 0) + 1;
  state.failed[id] = retries;
  saveState(state);
  return retries;
}

/** Pending events ready after minAgeMs; skips already processed. */
export function dequeuePending(minAgeMs: number): QueuedReportingEvent[] {
  const state = loadState();
  const processed = new Set(state.processed);
  const now = Date.now();
  return readAllEvents().filter((event) => {
    if (processed.has(event.id)) return false;
    const age = now - event.enqueuedAt;
    const delay =
      event.kind === "SHEETS" ? 0 : minAgeMs;
    return age >= delay;
  });
}

export function isEventProcessed(id: string): boolean {
  return loadState().processed.includes(id);
}
