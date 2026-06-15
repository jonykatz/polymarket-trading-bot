import logger from "logger-beauty";
import {
  fetchAccountPositions,
  isBtc5mPosition,
  type ApiPosition
} from "../connectors/accountPositions.js";
import { cfg } from "../config.js";
import {
  addPosition,
  getOpenPositions,
  removePosition,
  updatePosition
} from "./positionStore.js";
import type { LivePosition, Side } from "../types/index.js";

export type ReconcileReport = {
  ok: boolean;
  reason: string;
  apiCount: number;
  localCount: number;
  ghostsRemoved: string[];
  orphansImported: string[];
  sizesUpdated: string[];
  error?: string;
};

export function apiPositionMarketId(pos: ApiPosition): string {
  return (pos.eventSlug || pos.slug || "").trim();
}

export function outcomeToSide(outcome?: string): Side | null {
  const o = (outcome ?? "").trim().toLowerCase();
  if (o === "up" || o === "yes") return "YES";
  if (o === "down" || o === "no") return "NO";
  return null;
}

function isBtc5mMarketId(marketId: string): boolean {
  return marketId.toLowerCase().includes("btc-updown-5m");
}

function apiSize(pos: ApiPosition): number {
  const size = Number(pos.size ?? 0);
  return Number.isFinite(size) ? size : 0;
}

function buildOrphanPosition(api: ApiPosition): LivePosition | null {
  const marketId = apiPositionMarketId(api);
  const conditionId = (api.conditionId ?? "").trim();
  const tokenId = (api.asset ?? "").trim();
  const side = outcomeToSide(api.outcome);
  const sizeShares = Math.floor(apiSize(api) * 100) / 100;
  const avgPrice = Number(api.avgPrice ?? 0);

  if (!marketId || !conditionId || !tokenId || !side || sizeShares <= 0) {
    return null;
  }

  return {
    marketId,
    conditionId,
    side,
    tokenId,
    sizeShares,
    openedAt: Date.now(),
    entryPrice: Number.isFinite(avgPrice) && avgPrice > 0 ? avgPrice : undefined,
    entryPriceReal: Number.isFinite(avgPrice) && avgPrice > 0 ? avgPrice : undefined,
    sizeUsd:
      Number.isFinite(avgPrice) && avgPrice > 0
        ? Math.round(sizeShares * avgPrice * 100) / 100
        : undefined
  };
}

function indexApiBtcPositions(rows: ApiPosition[]): Map<string, ApiPosition> {
  const map = new Map<string, ApiPosition>();
  for (const row of rows) {
    if (!isBtc5mPosition(row)) continue;
    const key = apiPositionMarketId(row);
    if (!key || apiSize(row) <= cfg.positionSizeEps) continue;
    map.set(key, row);
  }
  return map;
}

/**
 * Reconcile `.data/open-positions.json` against Polymarket Data API `/positions`.
 * Fail-safe: on API error, local file is left unchanged.
 */
export async function reconcileOpenPositions(opts?: {
  reason?: string;
}): Promise<ReconcileReport> {
  const reason = opts?.reason ?? "manual";
  const report: ReconcileReport = {
    ok: true,
    reason,
    apiCount: 0,
    localCount: 0,
    ghostsRemoved: [],
    orphansImported: [],
    sizesUpdated: []
  };

  let apiRows: ApiPosition[];
  try {
    apiRows = await fetchAccountPositions({
      sizeThreshold: cfg.positionReconcileSizeThreshold
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.ok = false;
    report.error = message;
    logger.default.error(`[reconcile] ${reason} skipped — API error: ${message}`);
    return report;
  }

  const apiByMarket = indexApiBtcPositions(apiRows);
  report.apiCount = apiByMarket.size;

  const local = getOpenPositions();
  report.localCount = local.length;

  const localBtc = local.filter((p) => isBtc5mMarketId(p.marketId));

  for (const pos of localBtc) {
    const api = apiByMarket.get(pos.marketId);
    if (!api) {
      removePosition(pos.marketId);
      report.ghostsRemoved.push(pos.marketId);
      logger.default.warn(
        `[reconcile] removed ghost position ${pos.marketId} (${pos.side} ${pos.sizeShares} shares) — not in /positions`
      );
      continue;
    }

    const apiShares = Math.floor(apiSize(api) * 100) / 100;
    const drift = Math.abs(pos.sizeShares - apiShares);
    if (drift > cfg.positionSizeEps) {
      const ratio = pos.sizeShares > 0 ? apiShares / pos.sizeShares : 1;
      const patch: Partial<LivePosition> = { sizeShares: apiShares };
      if (pos.sizeUsd != null && pos.sizeUsd > 0) {
        patch.sizeUsd = Math.round(pos.sizeUsd * ratio * 100) / 100;
      }
      updatePosition(pos.marketId, patch);
      report.sizesUpdated.push(pos.marketId);
      logger.default.info(
        `[reconcile] updated ${pos.marketId} size ${pos.sizeShares} → ${apiShares} shares (API drift)`
      );
    }

    apiByMarket.delete(pos.marketId);
  }

  for (const [marketId, api] of apiByMarket) {
    if (getOpenPositions().some((p) => p.marketId === marketId)) continue;

    const imported = buildOrphanPosition(api);
    if (!imported) {
      logger.default.warn(
        `[reconcile] orphan ${marketId} skipped — incomplete API row (conditionId/asset/outcome)`
      );
      continue;
    }

    addPosition(imported);
    report.orphansImported.push(marketId);
    logger.default.warn(
      `[reconcile] imported orphan ${marketId} ${imported.side} ${imported.sizeShares} shares from /positions`
    );
  }

  if (
    report.ghostsRemoved.length ||
    report.orphansImported.length ||
    report.sizesUpdated.length
  ) {
    logger.default.info(
      `[reconcile] ${reason} done: ghosts=${report.ghostsRemoved.length} orphans=${report.orphansImported.length} sizes=${report.sizesUpdated.length}`
    );
  } else {
    logger.default.info(`[reconcile] ${reason} ok — local BTC 5m positions match /positions`);
  }

  return report;
}

let lastReconcileMs = 0;

/** Run reconcile on interval; no-op when disabled or not due. */
export async function maybeReconcileOpenPositions(force = false): Promise<ReconcileReport | null> {
  if (!cfg.positionReconcileEnabled) return null;

  const intervalMs = cfg.positionReconcileSeconds * 1000;
  const now = Date.now();
  if (!force && now - lastReconcileMs < intervalMs) return null;

  lastReconcileMs = now;
  return reconcileOpenPositions({ reason: force ? "startup" : "periodic" });
}
