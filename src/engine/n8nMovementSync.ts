import fs from "node:fs";
import path from "node:path";
import type { AccountMovementSheet, TradeLeg } from "../connectors/accountActivity.js";
import { cfg } from "../config.js";

const dataDir = path.join(process.cwd(), ".data");
const statePath = path.join(dataDir, "activity-sync-state.json");
const KNOWN_IDS_CAP = 500;

export type N8nMovementPayload = {
  movementId: string;
  timestamp: string;
  marketSlug: string;
  tradeLeg: TradeLeg;
  type: string;
  side: string | null;
  outcome: string | null;
  shares: number;
  price: number | null;
  cashFlowUsd: number;
  feeUsd: number | null;
  transactionHash: string;
  result: "" | "WIN" | "LOSS";
  syncedAt: string;
};

export type ActivitySyncState = {
  knownMovementIds: string[];
  lastPollAt?: string;
};

const MAX_RETRIES = 8;
const RETRY_BASE_MS = 15_000;

function ensureDataDir(): void {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

export function formatSyncedAtArgentina(): string {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
}

function movementMarketKey(
  movement: Pick<AccountMovementSheet, "marketSlug" | "eventSlug">
): string {
  return (movement.eventSlug || movement.marketSlug || "").trim();
}

function totalEntryCostUsd(entry: AccountMovementSheet): number {
  return Math.abs(entry.cashFlowUsd) + Math.abs(entry.feeUsd ?? 0);
}

function netExitProceedsUsd(exit: AccountMovementSheet): number {
  return exit.cashFlowUsd + (exit.feeUsd ?? 0);
}

/** Most recent ENTRY for same market/outcome before this EXIT. */
export function findMatchingEntry(
  exit: AccountMovementSheet,
  context: AccountMovementSheet[]
): AccountMovementSheet | null {
  const market = movementMarketKey(exit);
  if (!market) return null;

  let best: AccountMovementSheet | null = null;
  for (const row of context) {
    if (row.tradeLeg !== "ENTRY") continue;
    if (movementMarketKey(row) !== market) continue;
    if (exit.outcome && row.outcome && exit.outcome !== row.outcome) continue;
    if (row.timestampSec > exit.timestampSec) continue;
    if (!best || row.timestampSec > best.timestampSec) best = row;
  }
  return best;
}

export function inferSellResult(
  exit: AccountMovementSheet,
  entry: AccountMovementSheet
): "WIN" | "LOSS" {
  if (entry.shares <= 0 || exit.shares <= 0) return "LOSS";
  const costForSoldShares = (totalEntryCostUsd(entry) / entry.shares) * exit.shares;
  const net = netExitProceedsUsd(exit);
  return net >= costForSoldShares ? "WIN" : "LOSS";
}

export function inferResult(
  movement: AccountMovementSheet,
  context: AccountMovementSheet[] = []
): "" | "WIN" | "LOSS" {
  if (movement.tradeLeg !== "EXIT") return "";

  if (movement.type === "REDEEM") {
    return movement.cashFlowUsd > 0 ? "WIN" : "LOSS";
  }

  if (movement.type === "TRADE" && movement.side === "SELL") {
    const entry = findMatchingEntry(movement, context);
    if (entry) return inferSellResult(movement, entry);
    return "";
  }

  return "";
}

export function toN8nPayload(
  movement: AccountMovementSheet,
  syncedAt?: string,
  context: AccountMovementSheet[] = []
): N8nMovementPayload {
  const marketSlug = movementMarketKey(movement) || movement.marketSlug;
  return {
    movementId: movement.movementId,
    timestamp: movement.timestamp,
    marketSlug,
    tradeLeg: movement.tradeLeg,
    type: movement.type,
    side: movement.side,
    outcome: movement.outcome,
    shares: movement.shares,
    price: movement.price,
    cashFlowUsd: movement.cashFlowUsd,
    feeUsd: movement.feeUsd,
    transactionHash: movement.transactionHash,
    result: inferResult(movement, context),
    syncedAt: syncedAt ?? formatSyncedAtArgentina()
  };
}

function isRateLimitError(status: number, body: string): boolean {
  if (status === 429 || status === 503) return true;
  const lower = body.toLowerCase();
  return (
    lower.includes("quota exceeded") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("read requests per minute")
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function postMovement(url: string, payload: N8nMovementPayload): Promise<void> {
  let lastError = "unknown error";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await res.text().catch(() => "");

    if (res.ok && !isRateLimitError(res.status, body)) {
      return;
    }

    lastError = `n8n POST failed (${res.status}): ${body.slice(0, 300) || res.statusText}`;
    if (!isRateLimitError(res.status, body) || attempt >= MAX_RETRIES) {
      throw new Error(lastError);
    }

    const waitMs = RETRY_BASE_MS * Math.pow(2, attempt);
    await sleep(waitMs);
  }

  throw new Error(lastError);
}

export function loadActivitySyncState(): ActivitySyncState {
  ensureDataDir();
  if (!fs.existsSync(statePath)) {
    return { knownMovementIds: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as ActivitySyncState;
    const ids = Array.isArray(raw.knownMovementIds)
      ? raw.knownMovementIds.filter((id): id is string => typeof id === "string")
      : [];
    return { knownMovementIds: ids, lastPollAt: raw.lastPollAt };
  } catch {
    return { knownMovementIds: [] };
  }
}

export function saveActivitySyncState(state: ActivitySyncState): void {
  ensureDataDir();
  const pruned =
    state.knownMovementIds.length > KNOWN_IDS_CAP
      ? state.knownMovementIds.slice(-KNOWN_IDS_CAP)
      : state.knownMovementIds;
  fs.writeFileSync(
    statePath,
    JSON.stringify({ ...state, knownMovementIds: pruned }, null, 2),
    "utf8"
  );
}

export function isKnownMovement(id: string, state?: ActivitySyncState): boolean {
  const known = state ?? loadActivitySyncState();
  return known.knownMovementIds.includes(id);
}

export function markMovementSynced(id: string, state?: ActivitySyncState): ActivitySyncState {
  const current = state ?? loadActivitySyncState();
  if (current.knownMovementIds.includes(id)) {
    return { ...current, lastPollAt: new Date().toISOString() };
  }
  const knownMovementIds = [...current.knownMovementIds, id];
  const next = { knownMovementIds, lastPollAt: new Date().toISOString() };
  saveActivitySyncState(next);
  return next;
}

export function markMovementsSynced(ids: string[], state?: ActivitySyncState): ActivitySyncState {
  let current = state ?? loadActivitySyncState();
  for (const id of ids) {
    if (!current.knownMovementIds.includes(id)) {
      current = {
        knownMovementIds: [...current.knownMovementIds, id],
        lastPollAt: new Date().toISOString()
      };
    }
  }
  current.lastPollAt = new Date().toISOString();
  saveActivitySyncState(current);
  return current;
}

export function defaultPostDelayMs(): number {
  return cfg.n8nSyncDelayMs;
}
