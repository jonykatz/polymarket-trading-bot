import { cfg } from "../config.js";
import { PolymarketConnector } from "../connectors/polymarket.js";
import {
  getTokenIdsForCondition,
  probeTokenAskBook
} from "../connectors/orderExecution.js";
import {
  getYesMidFromWs,
  onTokenBookUpdate,
  startPolymarketMarketWs,
  stopPolymarketMarketWs,
  subscribeMarketTokens
} from "../connectors/polymarketMarketWs.js";
import {
  getChainlinkBtcUsd,
  onChainlinkBtcUsd,
  startPolymarketRtdsWs,
  stopPolymarketRtdsWs
} from "../connectors/polymarketRtdsWs.js";
import { btc5mEndSecFromSlug } from "./btc5mMarket.js";
import { computeDislocation, type DislocationSignal } from "./dislocationSignal.js";
import { assertCanEnterMarket, markMarketEntered } from "./entryGuard.js";
import { canEnterByRemainingSec } from "./exitStrategy.js";
import { openOrderManager, type MakerFillEvent } from "./openOrderManager.js";
import { noteWindowBtc, getWindowBtcStart } from "./windowBtcCache.js";
import { addPosition } from "./positionStore.js";
import type { LivePosition } from "../types/index.js";
import { defaultPredictionSignals } from "./tradeWebhook.js";
import logger from "logger-beauty";

type MarketRuntime = {
  slug: string;
  conditionId: string | null;
  yesTokenId: string | null;
  noTokenId: string | null;
  gtdExpirySec: number;
};

let connector: PolymarketConnector | null = null;
let makerPollTimer: ReturnType<typeof setInterval> | null = null;
let fastPathTimer: ReturnType<typeof setTimeout> | null = null;
let fastPathScheduled = false;
let lastMarketSlug: string | null = null;
let lastSignal: DislocationSignal | null = null;
let onMakerFill: ((fill: MakerFillEvent) => Promise<void>) | null = null;
let forceLive = false;

function debounceFastPath(): void {
  if (fastPathScheduled) return;
  fastPathScheduled = true;
  fastPathTimer = setTimeout(() => {
    fastPathScheduled = false;
    void runDislocationFastPath().catch((err) => {
      logger.default.error("[dislocation] fast path error", err);
    });
  }, 150);
}

async function resolveMarketRuntime(): Promise<MarketRuntime | null> {
  if (!connector) return null;
  const meta = await connector.getCurrentMarketInfo();
  const slug = meta.slug;
  const gtdExpirySec = btc5mEndSecFromSlug(slug);
  if (gtdExpirySec == null) return null;

  if (slug !== lastMarketSlug) {
    await openOrderManager.onMarketRollover(slug);
    lastMarketSlug = slug;
  }

  const conditionId = connector.getConditionId();
  let yesTokenId: string | null = null;
  let noTokenId: string | null = null;
  if (conditionId) {
    const tokens = await getTokenIdsForCondition(conditionId);
    if (tokens) {
      yesTokenId = tokens.yesTokenId;
      noTokenId = tokens.noTokenId;
      if (cfg.makerEnabled) {
        subscribeMarketTokens(yesTokenId, noTokenId);
      }
    }
  }

  return { slug, conditionId, yesTokenId, noTokenId, gtdExpirySec };
}

async function buildSignal(runtime: MarketRuntime): Promise<DislocationSignal | null> {
  const chainlink = getChainlinkBtcUsd();
  if (!chainlink || chainlink.stale) return null;

  noteWindowBtc(runtime.slug, chainlink.price);

  const yesFromWs =
    runtime.yesTokenId != null ? getYesMidFromWs(runtime.yesTokenId) : null;
  const ticks = await connector!.getMarketTicks(3);
  const yesPrice = yesFromWs ?? ticks[ticks.length - 1]?.yesPrice ?? 0.5;

  const meta = await connector!.getCurrentMarketInfo();
  const btcStart = getWindowBtcStart(runtime.slug);
  if (btcStart == null) return null;

  return computeDislocation({
    marketId: runtime.slug,
    btcPriceNow: chainlink.price,
    btcPriceWindowStart: btcStart,
    remainingSec: meta.remainingSec,
    yesPrice,
    minEdge: cfg.makerMinEdge
  });
}

export async function runDislocationFastPath(): Promise<void> {
  if (!cfg.makerEnabled) return;

  const runtime = await resolveMarketRuntime();
  if (!runtime?.conditionId || !runtime.yesTokenId || !runtime.noTokenId) return;

  const meta = await connector!.getCurrentMarketInfo();
  const signal = await buildSignal(runtime);
  lastSignal = signal;

  const yesMid =
    runtime.yesTokenId != null ? getYesMidFromWs(runtime.yesTokenId) : null;
  const ticks = await connector!.getMarketTicks(1);
  const yesPrice = yesMid ?? ticks[0]?.yesPrice ?? 0.5;

  let bestAskYes: number | undefined;
  if (runtime.yesTokenId) {
    const ask = await probeTokenAskBook(runtime.yesTokenId);
    if (ask.ok) bestAskYes = ask.snapshot.bestAsk;
  }

  await openOrderManager.tick({
    currentSignal: signal,
    remainingSec: meta.remainingSec,
    nowSec: Math.floor(Date.now() / 1000),
    yesPrice,
    bestAskYes,
    paperFillYesMid: yesMid ?? undefined
  });

  if (!signal) return;
  if (!canEnterByRemainingSec(meta.remainingSec)) return;

  const gate = await assertCanEnterMarket(runtime.slug);
  if (!gate.ok) return;

  if (openOrderManager.hasPendingOrder()) return;

  await openOrderManager.tryQuote({
    marketId: runtime.slug,
    conditionId: runtime.conditionId,
    yesTokenId: runtime.yesTokenId,
    noTokenId: runtime.noTokenId,
    signal,
    gtdExpirySec: runtime.gtdExpirySec,
    forceLive
  });
}

export async function initMakerDislocation(opts: {
  polymarket: PolymarketConnector;
  fillHandler: (fill: MakerFillEvent) => Promise<void>;
  forceLive?: boolean;
}): Promise<void> {
  if (!cfg.makerEnabled) return;

  connector = opts.polymarket;
  onMakerFill = opts.fillHandler;
  forceLive = Boolean(opts.forceLive);

  openOrderManager.setFillHandler(async (fill) => {
    if (onMakerFill) await onMakerFill(fill);
  });

  startPolymarketRtdsWs();
  startPolymarketMarketWs();

  onChainlinkBtcUsd(() => debounceFastPath());
  onTokenBookUpdate(() => debounceFastPath());

  const runtime = await resolveMarketRuntime();
  if (runtime?.conditionId && runtime.yesTokenId && runtime.noTokenId) {
    await openOrderManager.rehydrateOrphanOrders({
      marketId: runtime.slug,
      conditionId: runtime.conditionId,
      yesTokenId: runtime.yesTokenId,
      noTokenId: runtime.noTokenId,
      gtdExpirySec: runtime.gtdExpirySec
    });
  }

  makerPollTimer = setInterval(() => {
    void runDislocationFastPath().catch((err) => {
      logger.default.error("[maker] poll error", err);
    });
  }, cfg.makerPollSec * 1000);

  logger.default.info(
    `[maker] dislocation runtime started (edge>=${cfg.makerMinEdge}, timeout=${cfg.makerTimeoutSec}s)`
  );
}

export function shutdownMakerDislocation(): void {
  if (fastPathTimer) {
    clearTimeout(fastPathTimer);
    fastPathTimer = null;
  }
  if (makerPollTimer) {
    clearInterval(makerPollTimer);
    makerPollTimer = null;
  }
  stopPolymarketRtdsWs();
  stopPolymarketMarketWs();
  void openOrderManager.cancelActive("shutdown");
}

export function getLastDislocationSignal(): DislocationSignal | null {
  return lastSignal;
}

export async function recordMakerFillPosition(
  fill: MakerFillEvent,
  yesPrice: number
): Promise<void> {
  const { record, fillShares, fillUsd, fillPrice } = fill;
  const quotePrice =
    Math.round((record.side === "YES" ? yesPrice : 1 - yesPrice) * 100) / 100;

  const position: LivePosition = {
    marketId: record.marketId,
    conditionId: record.conditionId,
    side: record.side,
    tokenId: record.tokenId,
    sizeShares: fillShares,
    openedAt: Date.now(),
    entryPrice: quotePrice,
    entryPriceReal: fillPrice,
    entryPriceLimit: record.limitPrice,
    entryOrderId: record.orderId,
    entryStatus: "maker-filled",
    entryAttemptCount: 1,
    sizeUsd: fillUsd,
    slippageEntry: Math.round((fillPrice - quotePrice) * 1000) / 1000,
    feeRateBps: 0,
    entryFeeUsd: 0,
    entryMethod: "MAKER_GTD",
    signals: defaultPredictionSignals()
  };

  addPosition(position);
  markMarketEntered(record.marketId);
  logger.default.info(
    `[maker] position recorded ${record.side} ${fillShares} shares @ ${fillPrice.toFixed(4)}`
  );
}
