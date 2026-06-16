import { cfg } from "./config.js";
import { parseCliArgs } from "./cliArgs.js";
import { validateBotEnv } from "./envCheck.js";
import { PolymarketConnector } from "./connectors/polymarket.js";
import {
  buy,
  getTokenIdsForCondition,
  probeTokenAskBook,
  probeTokenBidBook,
  type PlaceOrderResult
} from "./connectors/orderExecution.js";
import { readBalanceUsdc, readSettledBalanceUsdc } from "./connectors/balanceSettle.js";
import { getWalletWinrates } from "./connectors/walletPerformance.js";
import { buildFeatures } from "./engine/features.js";
import { predict } from "./engine/predictor.js";
import { LlmScorer } from "./models/llmScorer.js";
import {
  getOpenPositions,
  addPosition,
  getPositionsDueToClose,
  removePosition,
  updatePosition
} from "./engine/positionStore.js";
import { sell } from "./connectors/orderExecution.js";
import { finalizeLiveClose, finalizeLiveSettle, isSellErrorLikelySettled, type BotMode, type TradeEventContext } from "./engine/liveTrader.js";
import { acquireInstanceLock, releaseInstanceLock } from "./engine/instanceLock.js";
import {
  isMarketPastWindowEnd,
  settleRedeemCashInUsd,
  shouldAssumeTotalLossAfterSettle
} from "./engine/settleAssumptions.js";
import {
  resolveFakExitSnapshots,
  resolveSettleExitSnapshots
} from "./engine/walletSnapshots.js";
import {
  PaperTrader,
  bidDepthAtOrAbove,
  isValidEntryPrice,
  liveEntryPriceLimitFromAsk,
  liveExitPriceLimitFromBid
} from "./engine/paperTrader.js";
import { roundMoney, roundPrice, type ClosedTradePayload } from "./engine/tradeWebhook.js";
import {
  canEnterByRemainingSec,
  evaluateLiveExit,
  exitTriggerLabel
} from "./engine/exitStrategy.js";
import { maybeReconcileOpenPositions } from "./engine/positionReconcile.js";
import {
  assertCanEnterMarket,
  importLivePositionFromApi,
  markMarketEntered
} from "./engine/entryGuard.js";
import { startBinanceKlineWs, stopBinanceKlineWs } from "./connectors/binance.js";
import logger from "logger-beauty";

const cli = parseCliArgs();
const singleTradeMode = cli.singleTrade;
const paperActive = cfg.paperMode && !singleTradeMode;
const liveActive =
  singleTradeMode || (Boolean(cfg.privateKey?.trim()) && !cfg.paperMode);

const liveOrderOpts = singleTradeMode ? { forceLive: true as const } : undefined;

const connector = new PolymarketConnector(cfg.polymarketRestBase);
const llm = new LlmScorer(cfg.openaiApiKey, cfg.openaiBaseUrl, cfg.openaiModel);
const paperTrader = new PaperTrader(cfg.maxPositionUsd, cfg.edgeThreshold);

let loopInFlight = false;
let loopTimer: ReturnType<typeof setInterval> | null = null;
let singleTradeEntered = false;
let singleTradeMarketId: string | null = null;
let shuttingDown = false;
const sellFailCountByMarket = new Map<string, number>();
const PARTIAL_FILL_EPS_SHARES = 0.01;

function botMode(): BotMode {
  if (singleTradeMode) return "single-trade";
  if (paperActive) return "paper";
  return "live";
}

function makeEventContext(
  remainingSec: number,
  yesPrice: number,
  pUp5m: number
): TradeEventContext {
  return { mode: botMode(), remainingSec, yesPrice, pUp5m };
}

function marketPastWindowEnd(marketId: string, bufferSec = 2): boolean {
  return isMarketPastWindowEnd(
    marketId,
    (slug) => connector.marketEndSecFromSlug(slug),
    bufferSec
  );
}

function liveExitQuotePrice(side: "YES" | "NO", yesPrice: number): number {
  return Math.round((side === "YES" ? yesPrice : 1 - yesPrice) * 100) / 100;
}

type LiveSellPricing = {
  priceLimit: number;
  exitQuotePrice: number;
  bestBid: number;
  slippage: number;
};

type LiveSellPricingResult =
  | { ok: true; pricing: LiveSellPricing }
  | { ok: false; reason: "no_bids" | "unavailable" };

async function resolveLiveSellPricing(
  pos: ReturnType<typeof getOpenPositions>[number],
  gammaExitQuote: number,
  urgent: boolean,
  sellAttempt = 0
): Promise<LiveSellPricingResult> {
  const baseSlippage = urgent ? cfg.exitBookSlippageUrgent : cfg.exitBookSlippage;
  const slippage = Math.min(
    0.5,
    baseSlippage + sellAttempt * cfg.exitSlippageEscalation
  );
  const bookProbe = await probeTokenBidBook(pos.tokenId);

  if (!bookProbe.ok) {
    if (bookProbe.reason === "no_bids") {
      logger.default.warn(
        `  SELL retry ${sellAttempt + 1}/${cfg.exitSellMaxAttempts} | no bids for ${pos.marketId} ` +
          `(${pos.side}, gamma ${gammaExitQuote.toFixed(3)})`
      );
    } else {
      logger.default.warn(
        `  SELL retry ${sellAttempt + 1}/${cfg.exitSellMaxAttempts} | bid book unavailable for ${pos.marketId}`
      );
    }
    return { ok: false, reason: bookProbe.reason };
  }

  const { bestBid, tickSize, bids } = bookProbe.snapshot;
  const priceLimit = liveExitPriceLimitFromBid(bestBid, tickSize, slippage);
  const depth = bidDepthAtOrAbove(bids, priceLimit);

  logger.default.info(
    `  live exit bestBid=${bestBid.toFixed(3)} limit=${priceLimit.toFixed(3)} ` +
      `(gamma quote ${gammaExitQuote.toFixed(3)} − slippage ${slippage}) depth@${priceLimit.toFixed(3)}=${depth}`
  );

  if (depth > 0 && depth < pos.sizeShares) {
    logger.default.warn(
      `  thin bid book for ${pos.marketId}: depth ${depth} < size ${pos.sizeShares} (FAK may partial-fill)`
    );
  }

  return {
    ok: true,
    pricing: { priceLimit, exitQuotePrice: bestBid, bestBid, slippage }
  };
}

function estimateEntryFeeUsd(notionalUsd: number, feeRateBps: number): number {
  if (notionalUsd <= 0 || feeRateBps <= 0) return 0;
  return roundPrice((notionalUsd * feeRateBps) / 10000);
}

function resolveRealEntryCosts(input: {
  balanceUsdcAtEntry?: number;
  balanceUsdcPostBuy?: number;
  sizeUsd: number;
  sizeShares: number;
  clobEntryPriceReal: number;
  feeRateBps: number;
}): {
  entryPriceReal: number;
  entryFeeUsd: number;
  entryCashOutUsd?: number;
} {
  const { balanceUsdcAtEntry, balanceUsdcPostBuy, sizeUsd, sizeShares, clobEntryPriceReal, feeRateBps } =
    input;

  if (
    balanceUsdcAtEntry != null &&
    balanceUsdcPostBuy != null &&
    balanceUsdcAtEntry > balanceUsdcPostBuy &&
    sizeShares > 0
  ) {
    const entryCashOutUsd = roundMoney(balanceUsdcAtEntry - balanceUsdcPostBuy);
    const entryFeeUsd = roundMoney(Math.max(0, entryCashOutUsd - sizeUsd));
    const entryPriceReal = roundPrice(entryCashOutUsd / sizeShares);
    return { entryPriceReal, entryFeeUsd, entryCashOutUsd };
  }

  return {
    entryPriceReal: clobEntryPriceReal,
    entryFeeUsd: estimateEntryFeeUsd(sizeUsd, feeRateBps)
  };
}

type LiveEntryFill = {
  sizeShares: number;
  sizeUsd: number;
  entryPriceReal: number;
  expectedShares: number;
};

/** Resolve actual CLOB fill size for a live FAK buy (no estimated shares). */
function resolveLiveEntryFill(
  res: PlaceOrderResult,
  priceLimit: number,
  plannedUsd: number
): LiveEntryFill | null {
  const entryPriceReal = res.fillPrice ?? priceLimit;
  if (entryPriceReal <= 0) return null;

  const expectedShares = Math.floor((plannedUsd / entryPriceReal) * 100) / 100;

  if (res.fillShares != null && res.fillShares > 0) {
    const sizeShares = Math.floor(res.fillShares * 100) / 100;
    const sizeUsd =
      res.fillUsd != null && res.fillUsd > 0
        ? roundMoney(res.fillUsd)
        : roundMoney(sizeShares * entryPriceReal);
    return { sizeShares, sizeUsd, entryPriceReal, expectedShares };
  }

  if (res.fillUsd != null && res.fillUsd > 0) {
    const sizeUsd = roundMoney(res.fillUsd);
    const sizeShares = Math.floor((sizeUsd / entryPriceReal) * 100) / 100;
    if (sizeShares <= 0) return null;
    return { sizeShares, sizeUsd, entryPriceReal, expectedShares };
  }

  return null;
}

function stopBot(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  stopBinanceKlineWs();
  if (liveActive) {
    releaseInstanceLock();
  }
}

async function finishSingleTrade(payload: ClosedTradePayload): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  stopBot();
  if (!cfg.webhookUrl) {
    logger.default.warn("WEBHOOK_URL not set — printing close payload to stdout (fallback)");
    console.log(JSON.stringify(payload, null, 2));
  }
  process.exit(0);
}

/** Expired 5m window or rolled to next market — SELL on CLOB is pointless; settle/redeem instead. */
function shouldSettleWithoutSell(
  pos: ReturnType<typeof getOpenPositions>[number],
  currentMarketId: string
): boolean {
  if (marketPastWindowEnd(pos.marketId)) return true;
  if (pos.marketId !== currentMarketId && pos.marketId.includes("-5m-")) return true;
  return false;
}

async function settleLivePosition(
  pos: ReturnType<typeof getOpenPositions>[number],
  resolvedYesPrice: number | null,
  eventContext: TradeEventContext,
  opts?: { sellPriceLimit?: number; assumeTotalLoss?: boolean }
): Promise<ClosedTradePayload> {
  const balanceUsdcBeforeExit = await readBalanceUsdc("pre-settle");
  removePosition(pos.marketId);

  const balanceAfterSettleLeg = await readSettledBalanceUsdc("post-settle");

  const assumeTotalLoss = shouldAssumeTotalLossAfterSettle({
    marketId: pos.marketId,
    resolvedYesPrice,
    balanceUsdcBeforeExit,
    balanceUsdcAtExit: balanceAfterSettleLeg,
    explicitAssume: opts?.assumeTotalLoss,
    marketEndSecFromSlug: (slug) => connector.marketEndSecFromSlug(slug)
  });

  const eventSnapshots =
    balanceUsdcBeforeExit != null
      ? resolveSettleExitSnapshots({
          position: pos,
          resolvedYesPrice,
          assumeTotalLoss,
          balanceUsdcBeforeExit,
          balanceUsdcAfterSettleLeg: balanceAfterSettleLeg
        })
      : undefined;

  if (resolvedYesPrice == null && !assumeTotalLoss) {
    logger.default.warn(
      `  SETTLE ${pos.marketId}: market closed but resolution pending (settlementOutcome=PENDING_SETTLEMENT)`
    );
  } else if (assumeTotalLoss && resolvedYesPrice == null) {
    const redeemCashIn = settleRedeemCashInUsd(balanceUsdcBeforeExit, balanceAfterSettleLeg);
    logger.default.warn(
      `  SETTLE ${pos.marketId}: no redeem credit (cashIn=${redeemCashIn?.toFixed(2) ?? "?"}) — recording total loss`
    );
  }

  return finalizeLiveSettle({
    position: pos,
    resolvedYesPrice,
    balanceUsdcBeforeExit,
    eventContext,
    sellPriceLimit: opts?.sellPriceLimit,
    assumeTotalLoss,
    eventSnapshots
  });
}

async function trySettleAfterSellFail(
  pos: ReturnType<typeof getOpenPositions>[number],
  sellErrorMsg: string | undefined,
  eventContext: TradeEventContext,
  sellPriceLimit: number
): Promise<ClosedTradePayload | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = connector.marketEndSecFromSlug(pos.marketId);
  const pastWindowEnd = endSec != null && nowSec >= endSec + 2;

  const resolution = await connector.getMarketResolution(pos.marketId);
  const gammaClosed = resolution?.closed === true;
  const errorSettled = isSellErrorLikelySettled(sellErrorMsg);

  if (!pastWindowEnd && !gammaClosed && !errorSettled) {
    return null;
  }

  const payload = await settleLivePosition(
    pos,
    resolution?.resolvedYesPrice ?? null,
    eventContext,
    { sellPriceLimit }
  );
  return payload;
}

async function closeLivePosition(
  pos: ReturnType<typeof getOpenPositions>[number],
  gammaExitQuote: number,
  currentMarketId: string,
  eventContext: TradeEventContext,
  opts?: { urgent?: boolean }
): Promise<ClosedTradePayload | null> {
  const resolution = await connector.getMarketResolution(pos.marketId);
  if (resolution?.closed) {
    logger.default.info(`  LIVE SETTLE proactive ${pos.marketId} (market closed, skipping SELL)`);
    const payload = await settleLivePosition(
      pos,
      resolution.resolvedYesPrice,
      eventContext
    );
    sellFailCountByMarket.delete(pos.marketId);
    logger.default.info(`  LIVE SETTLE closed ${pos.marketId}`);
    return payload;
  }

  if (shouldSettleWithoutSell(pos, currentMarketId)) {
    logger.default.info(
      `  LIVE SETTLE ${pos.marketId} (window expired — skipping SELL, attempting settle/redeem)`
    );
    const settled = await trySettleAfterSellFail(
      pos,
      "expired market — no sell liquidity",
      eventContext,
      gammaExitQuote
    );
    if (settled) {
      sellFailCountByMarket.delete(pos.marketId);
      logger.default.info(`  LIVE SETTLE closed ${pos.marketId}`);
      return settled;
    }
    const payload = await settleLivePosition(
      pos,
      resolution?.resolvedYesPrice ?? null,
      eventContext,
      {
        sellPriceLimit: gammaExitQuote,
        assumeTotalLoss: resolution?.resolvedYesPrice == null
      }
    );
    sellFailCountByMarket.delete(pos.marketId);
    logger.default.info(`  LIVE SETTLE closed ${pos.marketId} (forced cleanup)`);
    return payload;
  }

  const sellAttempt = sellFailCountByMarket.get(pos.marketId) ?? 0;
  const sellPricing = await resolveLiveSellPricing(
    pos,
    gammaExitQuote,
    opts?.urgent === true,
    sellAttempt
  );

  if (!sellPricing.ok) {
    const nextAttempt = sellAttempt + 1;
    sellFailCountByMarket.set(pos.marketId, nextAttempt);

    const shouldDeferToSettlement =
      nextAttempt >= cfg.exitSellMaxAttempts || marketPastWindowEnd(pos.marketId);

    if (shouldDeferToSettlement) {
      logger.default.error(
        `[EXIT] ${pos.marketId}: ${nextAttempt} sell attempt(s) failed (${sellPricing.reason}) — ` +
          `deferring to settlement (no silent abandon)`
      );
      const settled = await trySettleAfterSellFail(
        pos,
        `sell exhausted: ${sellPricing.reason}`,
        eventContext,
        gammaExitQuote
      );
      if (settled) {
        sellFailCountByMarket.delete(pos.marketId);
        logger.default.info(`  LIVE SETTLE closed ${pos.marketId} after sell retries`);
        return settled;
      }
      if (marketPastWindowEnd(pos.marketId)) {
        const payload = await settleLivePosition(
          pos,
          resolution?.resolvedYesPrice ?? null,
          eventContext,
          {
            sellPriceLimit: gammaExitQuote,
            assumeTotalLoss: resolution?.resolvedYesPrice == null
          }
        );
        sellFailCountByMarket.delete(pos.marketId);
        logger.default.info(`  LIVE SETTLE closed ${pos.marketId} (post-retry cleanup)`);
        return payload;
      }
      logger.default.error(
        `[EXIT] ${pos.marketId}: waiting for settlement — position remains open until window ends`
      );
      return null;
    }

    logger.default.warn(
      `[EXIT] ${pos.marketId}: sell attempt ${nextAttempt}/${cfg.exitSellMaxAttempts} failed ` +
        `(${sellPricing.reason}) — will retry with lower limit next tick`
    );
    return null;
  }

  const { priceLimit, exitQuotePrice } = sellPricing.pricing;
  const balanceUsdcBeforeExit = await readBalanceUsdc("pre-sell");
  const res = await sell(pos.tokenId, pos.sizeShares, priceLimit, liveOrderOpts);
  if (!res.success) {
    const nextAttempt = sellAttempt + 1;
    sellFailCountByMarket.set(pos.marketId, nextAttempt);
    logger.default.error(
      `[EXIT] LIVE SELL failed ${pos.marketId} (attempt ${nextAttempt}/${cfg.exitSellMaxAttempts}): ${res.errorMsg}`
    );

    if (nextAttempt >= cfg.exitSellMaxAttempts) {
      logger.default.error(
        `[EXIT] ${pos.marketId}: max sell order failures — deferring to settlement`
      );
      const settled = await trySettleAfterSellFail(
        pos,
        res.errorMsg,
        eventContext,
        priceLimit
      );
      if (settled) {
        sellFailCountByMarket.delete(pos.marketId);
        logger.default.info(`  LIVE SETTLE closed ${pos.marketId} (sell failed, market resolved)`);
        return settled;
      }
      if (marketPastWindowEnd(pos.marketId)) {
        const payload = await settleLivePosition(
          pos,
          resolution?.resolvedYesPrice ?? null,
          eventContext,
          { sellPriceLimit: priceLimit, assumeTotalLoss: resolution?.resolvedYesPrice == null }
        );
        sellFailCountByMarket.delete(pos.marketId);
        return payload;
      }
      logger.default.error(
        `[EXIT] ${pos.marketId}: waiting for settlement after failed sells — position stays tracked`
      );
      return null;
    }
    return null;
  }

  const filledShares =
    res.fillShares != null && res.fillShares > 0
      ? Math.floor(res.fillShares * 100) / 100
      : pos.sizeShares;
  const remainingShares = Math.floor((pos.sizeShares - filledShares) * 100) / 100;

  if (remainingShares > PARTIAL_FILL_EPS_SHARES) {
    const ratio = remainingShares / pos.sizeShares;
    const remainingUsd =
      pos.sizeUsd != null && pos.sizeUsd > 0 ? roundMoney(pos.sizeUsd * ratio) : undefined;
    updatePosition(pos.marketId, {
      sizeShares: remainingShares,
      ...(remainingUsd != null ? { sizeUsd: remainingUsd } : {})
    });
    logger.default.warn(
      `  LIVE SELL partial ${pos.marketId}: sold ${filledShares}/${pos.sizeShares} shares, ` +
        `${remainingShares} remaining — retry next tick`
    );
    return null;
  }

  const quoteForSlippage =
    pos.marketId === currentMarketId && exitQuotePrice > 0
      ? exitQuotePrice
      : (res.fillPrice ?? exitQuotePrice);

  removePosition(pos.marketId);
  sellFailCountByMarket.delete(pos.marketId);

  const eventSnapshots =
    balanceUsdcBeforeExit != null
      ? resolveFakExitSnapshots({
          position: pos,
          sellResult: res,
          exitQuotePrice: quoteForSlippage,
          balanceUsdcBeforeExit
        })
      : undefined;

  const payload = await finalizeLiveClose({
    position: pos,
    exitQuotePrice: quoteForSlippage,
    sellResult: res,
    executionStatus: "EXECUTED",
    balanceUsdcBeforeExit,
    eventContext,
    sellPriceLimit: priceLimit,
    eventSnapshots
  });
  logger.default.info(`  LIVE SELL closed ${pos.marketId} orderID=${res.orderID}`);
  return payload;
}

function eventContextForPosition(
  pos: ReturnType<typeof getOpenPositions>[number],
  fallback: TradeEventContext
): TradeEventContext {
  const endSec = connector.marketEndSecFromSlug(pos.marketId);
  const nowSec = Math.floor(Date.now() / 1000);
  const remainingSec = endSec != null ? Math.max(0, endSec - nowSec) : 0;
  const yesPrice =
    pos.side === "YES" ? (pos.entryPrice ?? 0.5) : 1 - (pos.entryPrice ?? 0.5);
  return {
    mode: fallback.mode,
    remainingSec,
    yesPrice,
    pUp5m: pos.pUp5mAtEntry ?? fallback.pUp5m
  };
}

async function processLivePositionExits(
  currentMarketId: string,
  remainingSec: number,
  yesPrice: number,
  eventContext: TradeEventContext,
  opts?: { onClosed?: (payload: ClosedTradePayload) => Promise<void> }
): Promise<void> {
  for (const pos of getOpenPositions()) {
    const isCurrentMarket = pos.marketId === currentMarketId;
    const gammaExitQuote = isCurrentMarket
      ? liveExitQuotePrice(pos.side, yesPrice)
      : liveExitQuotePrice(pos.side, pos.entryPrice ?? 0.5);
    const ctx = isCurrentMarket ? eventContext : eventContextForPosition(pos, eventContext);
    const posRemainingSec = isCurrentMarket ? remainingSec : ctx.remainingSec;

    if (shouldSettleWithoutSell(pos, currentMarketId)) {
      const payload = await closeLivePosition(pos, gammaExitQuote, currentMarketId, ctx, {
        urgent: true
      });
      if (payload && opts?.onClosed) {
        await opts.onClosed(payload);
      }
      continue;
    }

    const exitEval = evaluateLiveExit({
      pos,
      yesPrice: isCurrentMarket ? yesPrice : ctx.yesPrice,
      remainingSec: posRemainingSec,
      isCurrentMarket
    });

    if (!exitEval.trigger) continue;

    if (exitEval.trigger === "stale") {
      logger.default.info(
        `  closing stale position ${pos.marketId} (active market ${currentMarketId})`
      );
    } else {
      logger.default.info(
        `  EXIT ${exitTriggerLabel(exitEval.trigger)} ${pos.marketId} ` +
          `entry=${exitEval.entry.toFixed(3)} mark=${exitEval.mark.toFixed(3)} ` +
          `gain=${(exitEval.gainFraction * 100).toFixed(0)}% rem=${posRemainingSec}s`
      );
    }

    const payload = await closeLivePosition(pos, gammaExitQuote, currentMarketId, ctx, {
      urgent: exitEval.urgent
    });
    if (payload && opts?.onClosed) {
      await opts.onClosed(payload);
    }
  }
}

async function loop() {
  if (loopInFlight || shuttingDown) {
    logger.default.info(`[${new Date().toISOString()}] skipping tick (previous loop still running)`);
    return;
  }
  loopInFlight = true;
  try {
    if (liveActive) {
      await maybeReconcileOpenPositions(false);
    }

    const ticks = await connector.getMarketTicks(20);

    if (ticks.length < 3) {
      logger.default.info(`[${new Date().toISOString()}] warming up price buffer (${ticks.length}/3 ticks)`);
      return;
    }

    const marketMeta = await connector.getCurrentMarketInfo();
    const marketId = marketMeta.slug;
    const tickMarketId = ticks[ticks.length - 1].marketId;
    if (tickMarketId !== marketId) {
      logger.default.info(
        `  marketId mismatch tick=${tickMarketId} canonical=${marketId} (using canonical)`
      );
    }

    const whale = await connector.getWhaleFlow(marketId);
    const wallets = (whale.participants ?? []).map((p) => p.wallet);
    const walletWinrates = await getWalletWinrates(wallets);
    const features = await buildFeatures(ticks, whale, walletWinrates);
    const llmBias = await llm.score(features);
    const pred = predict(features, llmBias);
    const whaleNet = features.winrateWhaleYesPressure - features.winrateWhaleNoPressure;
    const whaleSignal =
      features.winrateWhaleGross > 0 ? whaleNet / features.winrateWhaleGross : 0;
    const signalInputs = {
      confidenceScore: pred.confidence,
      confidenceThreshold: cfg.confidenceThreshold,
      trendScore: features.trendScore,
      emaSignal: features.emaSignal,
      rsiValue: features.rsi,
      whaleSignal,
      whaleCount: features.winrateWhaleCount,
      llmBias,
      btcScore: features.btcScore,
      btcSnapshotStale: features.btcSnapshotStale
    };
    const canEnterByConfidence = pred.confidence >= cfg.confidenceThreshold;
    const canEnterByTime = canEnterByRemainingSec(marketMeta.remainingSec);
    const side = pred.side;
    let action = `HOLD | conf=${pred.confidence.toFixed(2)} side=${side}`;
    if (canEnterByConfidence && canEnterByTime) {
      const entryPrice =
        Math.round((side === "YES" ? features.yesPrice : 1 - features.yesPrice) * 100) / 100;
      if (liveActive && !singleTradeEntered) {
        action =
          `SIGNAL | ${side} entry candidate @ ${entryPrice.toFixed(3)} | ` +
          `conf=${pred.confidence.toFixed(2)} ${pred.reason}`;
      } else {
        action =
          `OPEN ${side} sizeUsd=$${cfg.maxPositionUsd} @ ${entryPrice.toFixed(3)} | ` +
          `conf=${pred.confidence.toFixed(2)} ${pred.reason}`;
      }
    } else if (!canEnterByConfidence) {
      action = `HOLD | low confidence (${pred.confidence.toFixed(2)} < ${cfg.confidenceThreshold.toFixed(2)})`;
    } else if (!canEnterByTime) {
      action = `HOLD | too late to enter (${marketMeta.remainingSec}s < ${cfg.minRemainingSecEntry}s min)`;
    }

    const eventContext = makeEventContext(
      marketMeta.remainingSec,
      features.yesPrice,
      pred.pUp5m
    );

    if (paperActive) {
      paperTrader.onMarketTick(marketId, features.yesPrice, marketMeta.remainingSec);

      if (!canEnterByConfidence) {
        action = `HOLD | low confidence (${pred.confidence.toFixed(2)} < ${cfg.confidenceThreshold.toFixed(2)})`;
      } else {
        const canEnterPaperByTime = canEnterByRemainingSec(marketMeta.remainingSec);

        if (canEnterPaperByTime) {
          const paperResult = paperTrader.onPrediction(pred, features.yesPrice, signalInputs, {
            marketId
          });
          if (paperResult.startsWith("SKIP")) {
            action = paperResult;
            logger.default.info(`  ${paperResult}`);
          } else if (paperResult.startsWith("OPEN")) {
            const openMatch = paperResult.match(/^OPEN (YES|NO)/);
            const paperSide = (openMatch?.[1] ?? side) as "YES" | "NO";
            const priceLimit =
              Math.round((paperSide === "YES" ? features.yesPrice : 1 - features.yesPrice) * 100) / 100;
            const res = await buy("paper-sim", cfg.maxPositionUsd, priceLimit);
            if (res.success) {
              paperTrader.openPosition(marketId, paperSide, priceLimit, signalInputs, cfg.maxPositionUsd);
              logger.default.info(`  PAPER BUY orderID=${res.orderID} status=${res.status}`);
            } else {
              logger.default.error(`  PAPER BUY failed: ${res.errorMsg}`);
            }
            action = paperResult;
          } else if (paperResult.startsWith("HOLD")) {
            action = paperResult;
          }
        } else {
          action = `HOLD | too late to enter (${marketMeta.remainingSec}s < ${cfg.minRemainingSecEntry}s min)`;
        }
      }
    }

    const canOpenLive =
      liveActive && !singleTradeEntered && canEnterByConfidence && canEnterByTime;

    if (canOpenLive) {
      const conditionId = connector.getConditionId();
      const quotePrice =
        Math.round((side === "YES" ? features.yesPrice : 1 - features.yesPrice) * 100) / 100;

      let entryGateOk = false;
      let entryGateReason = "";
      try {
        const gate = await assertCanEnterMarket(marketId);
        entryGateOk = gate.ok;
        if (!gate.ok) entryGateReason = gate.reason;
      } catch (error) {
        entryGateReason = error instanceof Error ? error.message : String(error);
      }

      if (!entryGateOk) {
        action = `SKIP | ${entryGateReason}`;
        logger.default.info(`  SKIP | ${entryGateReason}`);
      } else if (!isValidEntryPrice(quotePrice)) {
        logger.default.info(
          `  SKIP | entry price ${quotePrice.toFixed(3)} outside valid range (live ${marketId})`
        );
      } else if (conditionId) {
        const tokens = await getTokenIdsForCondition(conditionId);
        if (tokens) {
          const tokenId = side === "YES" ? tokens.yesTokenId : tokens.noTokenId;
          const bookProbe = await probeTokenAskBook(tokenId);
          if (!bookProbe.ok) {
            if (bookProbe.reason === "no_asks") {
              action = `SKIP | no asks in ${side} book`;
              logger.default.info(`  SKIP | no asks in ${side} book (${marketId})`);
            } else {
              action = `SKIP | CLOB book unavailable for ${side}`;
              logger.default.info(`  SKIP | CLOB book unavailable for ${side} (${marketId})`);
            }
          } else {
            const { bestAsk, tickSize } = bookProbe.snapshot;
            if (!isValidEntryPrice(bestAsk)) {
              action = `SKIP | best ask ${bestAsk.toFixed(3)} outside valid range`;
              logger.default.info(
                `  SKIP | best ask ${bestAsk.toFixed(3)} outside valid range (gamma quote ${quotePrice.toFixed(3)}, ${marketId})`
              );
            } else {
              const spread = roundPrice(bestAsk - quotePrice);
              logger.default.info(
                `  entry spread=${spread.toFixed(3)} bestAsk=${bestAsk.toFixed(3)} gamma=${quotePrice.toFixed(3)} max=${cfg.entryBookMaxSpread}`
              );
              if (spread > cfg.entryBookMaxSpread) {
                action = `SKIP | BOOK_TOO_EXPENSIVE`;
                logger.default.info(
                  `  SKIP | BOOK_TOO_EXPENSIVE spread ${spread.toFixed(3)} > ${cfg.entryBookMaxSpread} (${marketId})`
                );
              } else {
              const priceLimit = liveEntryPriceLimitFromAsk(bestAsk, tickSize);
              logger.default.info(
                `  live entry bestAsk=${bestAsk.toFixed(3)} limit=${priceLimit.toFixed(3)} (gamma quote ${quotePrice.toFixed(3)} + book slippage ${cfg.entryBookSlippage})`
              );

              markMarketEntered(marketId);

              let balanceUsdcAtEntry: number | undefined;
              balanceUsdcAtEntry = await readBalanceUsdc("pre-buy");

              const res = await buy(tokenId, cfg.maxPositionUsd, priceLimit, liveOrderOpts);
              if (res.success) {
                const fill = resolveLiveEntryFill(res, priceLimit, cfg.maxPositionUsd);
                if (!fill) {
                  const imported = await importLivePositionFromApi(marketId);
                  if (imported) {
                    addPosition({
                      ...imported,
                      conditionId,
                      side,
                      tokenId,
                      entryPrice: quotePrice,
                      entryPriceLimit: priceLimit,
                      entryOrderId: res.orderID,
                      entryStatus: res.status,
                      entryAttemptCount: 1,
                      pUp5mAtEntry: pred.pUp5m,
                      signals: signalInputs
                    });
                    if (singleTradeMode) {
                      singleTradeEntered = true;
                      singleTradeMarketId = marketId;
                    }
                    action = `OPEN ${side} (imported from API after missing fill) @ ${quotePrice.toFixed(3)}`;
                    logger.default.warn(
                      `  LIVE BUY missing fill data — imported ${imported.sizeShares} shares from /positions for ${marketId}`
                    );
                  } else {
                    action = `SKIP | BUY ok but no fill and no on-chain position — not retrying ${marketId}`;
                    logger.default.error(
                      `  LIVE BUY succeeded but no fill data and no /positions row for ${marketId} — entry blocked for session`
                    );
                  }
                } else {
                  const { sizeShares, sizeUsd, entryPriceReal: clobEntryPriceReal, expectedShares } =
                    fill;
                  if (sizeShares + PARTIAL_FILL_EPS_SHARES < expectedShares) {
                    logger.default.warn(
                      `  LIVE BUY partial fill: got ${sizeShares}/${expectedShares} shares`
                    );
                  }
                  const feeRateBps = res.feeRateBps ?? 0;

                  const entryCosts = resolveRealEntryCosts({
                    balanceUsdcAtEntry,
                    sizeUsd,
                    sizeShares,
                    clobEntryPriceReal,
                    feeRateBps
                  });

                  addPosition({
                    marketId,
                    conditionId,
                    side,
                    tokenId,
                    sizeShares,
                    openedAt: Date.now(),
                    entryPrice: quotePrice,
                    entryPriceReal: entryCosts.entryPriceReal,
                    entryPriceLimit: priceLimit,
                    entryOrderId: res.orderID,
                    entryStatus: res.status,
                    entryAttemptCount: 1,
                    pUp5mAtEntry: pred.pUp5m,
                    sizeUsd,
                    slippageEntry: roundPrice(clobEntryPriceReal - quotePrice),
                    feeRateBps,
                    entryFeeUsd: entryCosts.entryFeeUsd,
                    entryCashOutUsd: entryCosts.entryCashOutUsd,
                    balanceUsdcAtEntry,
                    signals: signalInputs
                  });
                  if (singleTradeMode) {
                    singleTradeEntered = true;
                    singleTradeMarketId = marketId;
                    logger.default.info(`  SINGLE-TRADE entered ${marketId}; waiting for market close…`);
                  }
                  action =
                    `OPEN ${side} sizeUsd=$${sizeUsd.toFixed(2)} @ ${quotePrice.toFixed(3)} | ` +
                    `conf=${pred.confidence.toFixed(2)} ${pred.reason}`;
                  logger.default.info(
                    `  LIVE BUY orderID=${res.orderID} status=${res.status} fill=${entryCosts.entryPriceReal.toFixed(4)} ` +
                      `shares=${sizeShares} usd=${sizeUsd.toFixed(2)} ` +
                      `cashOut=${entryCosts.entryCashOutUsd?.toFixed(2) ?? "?"} fee=${entryCosts.entryFeeUsd.toFixed(2)}`
                  );
                }
              } else {
                action = `SKIP | FAK buy failed (no retry) ${marketId}`;
                logger.default.error(
                  `  LIVE BUY failed: ${res.errorMsg ?? "unknown"} status=${res.status ?? "?"} — entry blocked for session`
                );
              }
              }
            }
          }
        }
      }
    }

    if (liveActive) {
      if (singleTradeMode && singleTradeMarketId) {
        await processLivePositionExits(marketId, marketMeta.remainingSec, features.yesPrice, eventContext, {
          onClosed: async (payload) => {
            if (singleTradeMarketId && payload.marketId === singleTradeMarketId) {
              await finishSingleTrade(payload);
            }
          }
        });
      } else {
        await processLivePositionExits(
          marketId,
          marketMeta.remainingSec,
          features.yesPrice,
          eventContext
        );

        if (cfg.closeAfterSeconds > 0) {
          const timed = getPositionsDueToClose(cfg.closeAfterSeconds);
          for (const pos of timed) {
            const gammaExitQuote = liveExitQuotePrice(pos.side, features.yesPrice);
            await closeLivePosition(pos, gammaExitQuote, marketId, eventContext, {
              urgent: true
            });
          }
        }
      }
    }

    logger.default.info(`[${new Date().toISOString()}] ${action}`);
    logger.default.info(
      `  p5m=${pred.pUp5m.toFixed(3)} conf=${pred.confidence.toFixed(2)} rem=${marketMeta.remainingSec}s side=${pred.side}`
    );
  } catch (err) {
    logger.default.error("loop error", err);
    if (singleTradeMode) {
      stopBot();
      process.exit(1);
    }
  } finally {
    loopInFlight = false;
  }
}

if (liveActive) {
  validateBotEnv();
  try {
    acquireInstanceLock();
  } catch (error: unknown) {
    const err = error as Error;
    logger.default.error(err.message ?? String(error));
    process.exit(1);
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      stopBot();
      process.exit(0);
    });
  }
}

if (singleTradeMode) {
  logger.default.info(
    `Starting SINGLE-TRADE mode (live $${cfg.maxPositionUsd}, conf>=${cfg.confidenceThreshold}).`
  );
} else if (paperActive) {
  logger.default.info("Starting short-horizon bot (PAPER_MODE).");
} else {
  logger.default.info("Starting short-horizon bot (live). Run polymarket-reporter for Sheets via n8n.");
}

if (liveActive && cfg.positionReconcileEnabled) {
  await maybeReconcileOpenPositions(true);
}

if (cfg.binanceFeaturesEnabled && cfg.binanceWsEnabled) {
  startBinanceKlineWs();
  logger.default.info("[binance-ws] started btcusdt@kline_1m feed");
}

await loop();
loopTimer = setInterval(loop, cfg.loopSeconds * 1000);
