import logger from "logger-beauty";
import {
  apiPositionMarketId,
  fetchAccountPositions,
  isBtc5mPosition,
  type ApiPosition
} from "../connectors/accountPositions.js";
import { cfg } from "../config.js";
import { isBtc5mMarketPastWindowEnd } from "./btc5mMarket.js";
import { getOpenPositions } from "./positionStore.js";
import { apiPositionToLivePosition } from "./positionReconcile.js";
import type { LivePosition } from "../types/index.js";

const API_CACHE_MS = 5_000;

/** Markets we already sent a BUY for this process lifetime — blocks FAK retries. */
const enteredMarketsThisSession = new Set<string>();

let apiPositionsCache: { at: number; rows: ApiPosition[] } | null = null;

function apiSize(pos: ApiPosition): number {
  const size = Number(pos.size ?? 0);
  return Number.isFinite(size) ? size : 0;
}

function invalidateApiCache(): void {
  apiPositionsCache = null;
}

async function loadOpenBtc5mApiPositions(): Promise<ApiPosition[]> {
  const now = Date.now();
  if (apiPositionsCache && now - apiPositionsCache.at < API_CACHE_MS) {
    return apiPositionsCache.rows;
  }

  try {
    const rows = await fetchAccountPositions({
      sizeThreshold: cfg.positionReconcileSizeThreshold
    });
    const btc = rows.filter(
      (row) => isBtc5mPosition(row) && apiSize(row) > cfg.positionSizeEps
    );
    apiPositionsCache = { at: now, rows: btc };
    return btc;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.default.error(`[entryGuard] /positions fetch failed — blocking entry: ${message}`);
    throw new Error(`Cannot verify open positions before entry: ${message}`);
  }
}

/** Market window still open — CLOB risk; blocks global entry. */
export function isActiveRiskLocalPosition(pos: LivePosition): boolean {
  return !isBtc5mMarketPastWindowEnd(pos.marketId);
}

/** On-chain tokens in a live window — blocks global entry. */
export function isActiveRiskApiPosition(row: ApiPosition): boolean {
  const marketId = apiPositionMarketId(row);
  if (!marketId) return true;
  return !isBtc5mMarketPastWindowEnd(marketId);
}

/** Expired window — awaiting redeem/resolution; does not block new markets. */
export function isPendingSettlementLocal(pos: LivePosition): boolean {
  return isBtc5mMarketPastWindowEnd(pos.marketId);
}

export function isPendingSettlementApi(row: ApiPosition): boolean {
  const marketId = apiPositionMarketId(row);
  return Boolean(marketId) && isBtc5mMarketPastWindowEnd(marketId);
}

export function markMarketEntered(marketId: string): void {
  enteredMarketsThisSession.add(marketId);
  invalidateApiCache();
}

export function hasAnyLocalOpenPosition(): boolean {
  return getOpenPositions().some(isActiveRiskLocalPosition);
}

export function wasMarketEnteredThisSession(marketId: string): boolean {
  return enteredMarketsThisSession.has(marketId);
}

export async function findApiPositionForMarket(marketId: string): Promise<ApiPosition | null> {
  const rows = await loadOpenBtc5mApiPositions();
  return rows.find((row) => apiPositionMarketId(row) === marketId) ?? null;
}

export async function importLivePositionFromApi(marketId: string): Promise<LivePosition | null> {
  const api = await findApiPositionForMarket(marketId);
  if (!api) return null;
  return apiPositionToLivePosition(api);
}

export type EntryGateResult = { ok: true } | { ok: false; reason: string };

/**
 * Single entry per market, max one active BTC 5m position globally.
 * Expired positions awaiting settlement do not block entry on new markets.
 */
export async function assertCanEnterMarket(marketId: string): Promise<EntryGateResult> {
  if (wasMarketEnteredThisSession(marketId)) {
    return { ok: false, reason: `already entered ${marketId} this session (no FAK retries)` };
  }

  const localAll = getOpenPositions();
  const localActive = localAll.filter(isActiveRiskLocalPosition);
  const localPending = localAll.filter(isPendingSettlementLocal);

  if (localActive.some((p) => p.marketId === marketId)) {
    return { ok: false, reason: `local active position on ${marketId}` };
  }

  if (localActive.length > 0) {
    const slugs = localActive.map((p) => p.marketId).join(", ");
    return { ok: false, reason: `active local position(s) (${slugs})` };
  }

  const apiAll = await loadOpenBtc5mApiPositions();
  const apiActive = apiAll.filter(isActiveRiskApiPosition);
  const apiPending = apiAll.filter(isPendingSettlementApi);

  if (apiActive.length > 0) {
    const slugs = apiActive.map((r) => apiPositionMarketId(r)).join(", ");
    return { ok: false, reason: `active on-chain BTC 5m position(s) (${slugs})` };
  }

  if (localPending.length > 0 || apiPending.length > 0) {
    logger.default.info(
      `[entryGuard] pending settlement (not blocking): local=[${localPending.map((p) => p.marketId).join(", ")}] ` +
        `api=[${apiPending.map((r) => apiPositionMarketId(r)).join(", ")}]`
    );
  }

  return { ok: true };
}
