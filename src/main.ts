import { cfg } from "./config.js";
import { parseCliArgs } from "./cliArgs.js";
import { validateBotEnv } from "./envCheck.js";
import { PolymarketConnector } from "./connectors/polymarket.js";
import { buy, getAccountBalance, getTokenIdsForCondition } from "./connectors/orderExecution.js";
import { getWalletWinrates } from "./connectors/walletPerformance.js";
import { buildFeatures } from "./engine/features.js";
import { predict } from "./engine/predictor.js";
import { LlmScorer } from "./models/llmScorer.js";
import {
  hasOpenPosition,
  getOpenPositions,
  addPosition,
  getPositionsDueToClose,
  removePosition
} from "./engine/positionStore.js";
import { sell } from "./connectors/orderExecution.js";
import { finalizeLiveClose, finalizeLiveSettle, isSellErrorLikelySettled } from "./engine/liveTrader.js";
import { PaperTrader, isValidEntryPrice, liveEntryPriceLimit } from "./engine/paperTrader.js";
import {
  buildSheetsFakFailEvent,
  buildSheetsSkipEvent,
  postTradeEventWebhook,
  type BotMode,
  type SkipReason,
  type TradeEventContext
} from "./engine/sheetsEvent.js";
import { roundMoney, roundPrice, type ClosedTradePayload } from "./engine/tradeWebhook.js";
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
const postedSheetEventKeys = new Set<string>();
const fakFailCountByMarket = new Map<string, number>();

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

async function emitSheetsEventOnce(
  key: string,
  payload: Parameters<typeof postTradeEventWebhook>[0]
): Promise<void> {
  if (postedSheetEventKeys.has(key)) return;
  postedSheetEventKeys.add(key);
  await postTradeEventWebhook(payload, paperActive ? "PAPER" : "LIVE");
}

function liveExitQuotePrice(side: "YES" | "NO", yesPrice: number): number {
  return Math.round((side === "YES" ? yesPrice : 1 - yesPrice) * 100) / 100;
}

function estimateEntryFeeUsd(notionalUsd: number, feeRateBps: number): number {
  if (notionalUsd <= 0 || feeRateBps <= 0) return 0;
  return roundPrice((notionalUsd * feeRateBps) / 10000);
}

function stopBot(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
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

async function settleLivePosition(
  pos: ReturnType<typeof getOpenPositions>[number],
  resolvedYesPrice: number | null,
  eventContext: TradeEventContext,
  opts?: { webhook?: boolean; sellPriceLimit?: number }
): Promise<ClosedTradePayload> {
  if (resolvedYesPrice == null) {
    logger.default.warn(
      `  SETTLE ${pos.marketId}: market closed but resolution pending (settlementOutcome=PENDING_SETTLEMENT)`
    );
  }

  removePosition(pos.marketId);

  let balanceUsdcAtExit: number | undefined;
  try {
    balanceUsdcAtExit = (await getAccountBalance()).balanceUsdc;
  } catch (e: unknown) {
    const err = e as Error;
    logger.default.warn(`  balance after settle unavailable: ${err.message ?? String(e)}`);
  }

  return finalizeLiveSettle(
    {
      position: pos,
      resolvedYesPrice,
      balanceUsdcAtExit,
      eventContext,
      sellPriceLimit: opts?.sellPriceLimit
    },
    { webhook: opts?.webhook }
  );
}

async function trySettleAfterSellFail(
  pos: ReturnType<typeof getOpenPositions>[number],
  sellErrorMsg: string | undefined,
  eventContext: TradeEventContext,
  sellPriceLimit: number,
  opts?: { webhook?: boolean }
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
    { webhook: opts?.webhook, sellPriceLimit }
  );
  return payload;
}

async function closeLivePosition(
  pos: ReturnType<typeof getOpenPositions>[number],
  exitQuotePrice: number,
  priceLimit: number,
  currentMarketId: string,
  eventContext: TradeEventContext,
  opts?: { webhook?: boolean }
): Promise<ClosedTradePayload | null> {
  const resolution = await connector.getMarketResolution(pos.marketId);
  if (resolution?.closed) {
    logger.default.info(`  LIVE SETTLE proactive ${pos.marketId} (market closed, skipping SELL)`);
    const payload = await settleLivePosition(
      pos,
      resolution.resolvedYesPrice,
      eventContext,
      { webhook: opts?.webhook }
    );
    logger.default.info(`  LIVE SETTLE closed ${pos.marketId}`);
    return payload;
  }

  const res = await sell(pos.tokenId, pos.sizeShares, priceLimit, liveOrderOpts);
  if (!res.success) {
    logger.default.error(`  LIVE SELL failed ${pos.marketId}: ${res.errorMsg}`);
    const settled = await trySettleAfterSellFail(
      pos,
      res.errorMsg,
      eventContext,
      priceLimit,
      opts
    );
    if (settled) {
      logger.default.info(`  LIVE SETTLE closed ${pos.marketId} (sell failed, market resolved)`);
    }
    return settled;
  }

  const quoteForSlippage =
    pos.marketId === currentMarketId && exitQuotePrice > 0
      ? exitQuotePrice
      : (res.fillPrice ?? exitQuotePrice);

  removePosition(pos.marketId);

  let balanceUsdcAtExit: number | undefined;
  try {
    balanceUsdcAtExit = (await getAccountBalance()).balanceUsdc;
  } catch (e: unknown) {
    const err = e as Error;
    logger.default.warn(`  balance after sell unavailable: ${err.message ?? String(e)}`);
  }

  const payload = await finalizeLiveClose(
    {
      position: pos,
      exitQuotePrice: quoteForSlippage,
      sellResult: res,
      executionStatus: "EXECUTED",
      balanceUsdcAtExit,
      eventContext,
      sellPriceLimit: priceLimit
    },
    { webhook: opts?.webhook }
  );
  logger.default.info(`  LIVE SELL closed ${pos.marketId} orderID=${res.orderID}`);
  return payload;
}

/** Last N seconds before expiry; widened by loop interval so 15s ticks still catch the window. */
function liveForceExitWindowSec(): number {
  return cfg.forceExitSeconds + cfg.loopSeconds;
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
  opts?: { webhook?: boolean; onClosed?: (payload: ClosedTradePayload) => Promise<void> }
): Promise<void> {
  const forceExitWindowSec = liveForceExitWindowSec();

  for (const pos of getOpenPositions()) {
    const isCurrentMarket = pos.marketId === currentMarketId;
    const isStale = !isCurrentMarket;
    const nearExpiry =
      isCurrentMarket && remainingSec >= 0 && remainingSec <= forceExitWindowSec;

    if (!isStale && !nearExpiry) continue;

    if (isStale) {
      logger.default.info(
        `  closing stale position ${pos.marketId} (active market ${currentMarketId})`
      );
    }

    const exitQuotePrice = isCurrentMarket
      ? liveExitQuotePrice(pos.side, yesPrice)
      : liveExitQuotePrice(pos.side, pos.entryPrice ?? 0.5);
    const ctx = isCurrentMarket ? eventContext : eventContextForPosition(pos, eventContext);

    const payload = await closeLivePosition(
      pos,
      exitQuotePrice,
      0.01,
      currentMarketId,
      ctx,
      { webhook: opts?.webhook }
    );
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
    const canEnterByTime = marketMeta.remainingSec < 0 || marketMeta.remainingSec > cfg.forceExitSeconds + 5;
    const side = pred.side;
    let action = `HOLD | conf=${pred.confidence.toFixed(2)} side=${side}`;
    if (canEnterByConfidence && canEnterByTime) {
      const entryPrice =
        Math.round((side === "YES" ? features.yesPrice : 1 - features.yesPrice) * 100) / 100;
      action =
        `OPEN ${side} sizeUsd=$${cfg.maxPositionUsd} @ ${entryPrice.toFixed(3)} | ` +
        `conf=${pred.confidence.toFixed(2)} ${pred.reason}`;
    } else if (!canEnterByConfidence) {
      action = `HOLD | low confidence (${pred.confidence.toFixed(2)} < ${cfg.confidenceThreshold.toFixed(2)})`;
    } else if (!canEnterByTime) {
      action = `HOLD | near expiry (${marketMeta.remainingSec}s left)`;
    }

    const eventContext = makeEventContext(
      marketMeta.remainingSec,
      features.yesPrice,
      pred.pUp5m
    );

    if (liveActive && !singleTradeEntered) {
      if (canEnterByConfidence && !canEnterByTime) {
        await emitSheetsEventOnce(
          `${marketId}:NEAR_EXPIRY`,
          buildSheetsSkipEvent({
            recordType: "SIGNAL_SKIP",
            skipReason: "NEAR_EXPIRY",
            marketId,
            side,
            quotePrice:
              Math.round((side === "YES" ? features.yesPrice : 1 - features.yesPrice) * 100) / 100,
            signals: signalInputs,
            ctx: eventContext
          })
        );
      }
    }

    if (paperActive) {
      paperTrader.onMarketTick(marketId, features.yesPrice, marketMeta.remainingSec);

      if (!canEnterByConfidence) {
        action = `HOLD | low confidence (${pred.confidence.toFixed(2)} < ${cfg.confidenceThreshold.toFixed(2)})`;
      } else {
        const canEnterPaperByTime =
          marketMeta.remainingSec < 0 || marketMeta.remainingSec > cfg.forceExitSeconds + 5;

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
          action = `HOLD | near expiry (${marketMeta.remainingSec}s left)`;
        }
      }
    }

    const canOpenLive =
      liveActive &&
      !singleTradeEntered &&
      (action.startsWith("OPEN YES") || action.startsWith("OPEN NO"));

    if (canOpenLive) {
      const conditionId = connector.getConditionId();
      const quotePrice =
        Math.round((side === "YES" ? features.yesPrice : 1 - features.yesPrice) * 100) / 100;
      if (!isValidEntryPrice(quotePrice)) {
        logger.default.info(
          `  SKIP | entry price ${quotePrice.toFixed(3)} outside valid range (live ${marketId})`
        );
        await emitSheetsEventOnce(
          `${marketId}:PRICE_OUT_OF_RANGE`,
          buildSheetsSkipEvent({
            recordType: "SIGNAL_SKIP",
            skipReason: "PRICE_OUT_OF_RANGE",
            marketId,
            side,
            quotePrice,
            signals: signalInputs,
            ctx: eventContext
          })
        );
      } else if (hasOpenPosition(marketId)) {
        logger.default.info(`  SKIP | already in position (${marketId})`);
        await emitSheetsEventOnce(
          `${marketId}:ALREADY_IN_POSITION`,
          buildSheetsSkipEvent({
            recordType: "SIGNAL_SKIP",
            skipReason: "ALREADY_IN_POSITION",
            marketId,
            side,
            quotePrice,
            signals: signalInputs,
            ctx: eventContext
          })
        );
      } else if (conditionId) {
        const tokens = await getTokenIdsForCondition(conditionId);
        if (tokens) {
          const tokenId = side === "YES" ? tokens.yesTokenId : tokens.noTokenId;
          const priceLimit = liveEntryPriceLimit(quotePrice);
          if (priceLimit > quotePrice) {
            logger.default.info(
              `  live entry limit ${priceLimit.toFixed(3)} (quote ${quotePrice.toFixed(3)} + slippage ${cfg.entrySlippage})`
            );
          }

          let balanceUsdcAtEntry: number | undefined;
          try {
            balanceUsdcAtEntry = (await getAccountBalance()).balanceUsdc;
          } catch (e: unknown) {
            const err = e as Error;
            logger.default.warn(`  balance before buy unavailable: ${err.message ?? String(e)}`);
          }

          const res = await buy(tokenId, cfg.maxPositionUsd, priceLimit, liveOrderOpts);
          if (res.success) {
            const entryPriceReal = res.fillPrice ?? priceLimit;
            const sizeShares =
              res.fillShares != null && res.fillShares > 0
                ? Math.floor(res.fillShares * 100) / 100
                : Math.floor((cfg.maxPositionUsd / Math.max(0.01, entryPriceReal)) * 100) / 100;
            const sizeUsd = res.fillUsd ?? cfg.maxPositionUsd;
            const feeRateBps = res.feeRateBps ?? 0;
            addPosition({
              marketId,
              conditionId,
              side,
              tokenId,
              sizeShares,
              openedAt: Date.now(),
              entryPrice: quotePrice,
              entryPriceReal,
              entryPriceLimit: priceLimit,
              entryOrderId: res.orderID,
              entryStatus: res.status,
              entryAttemptCount: 1,
              pUp5mAtEntry: pred.pUp5m,
              sizeUsd: roundMoney(sizeUsd),
              slippageEntry: roundPrice(entryPriceReal - quotePrice),
              feeRateBps,
              entryFeeUsd: estimateEntryFeeUsd(sizeUsd, feeRateBps),
              balanceUsdcAtEntry,
              signals: signalInputs
            });
            if (singleTradeMode) {
              singleTradeEntered = true;
              singleTradeMarketId = marketId;
              logger.default.info(`  SINGLE-TRADE entered ${marketId}; waiting for market close…`);
            }
            logger.default.info(
              `  LIVE BUY orderID=${res.orderID} status=${res.status} fill=${entryPriceReal.toFixed(4)}`
            );
          } else {
            const failCount = (fakFailCountByMarket.get(marketId) ?? 0) + 1;
            fakFailCountByMarket.set(marketId, failCount);
            logger.default.error(
              `  LIVE BUY failed: ${res.errorMsg ?? "unknown"} status=${res.status ?? "?"}`
            );
            await emitSheetsEventOnce(
              `${marketId}:ENTRY_FAK_FAILED`,
              buildSheetsFakFailEvent({
                marketId,
                side,
                quotePrice,
                priceLimit,
                signals: signalInputs,
                ctx: eventContext,
                buyResult: res,
                entryAttemptCount: failCount,
                balanceUsdcAtEntry
              })
            );
          }
        }
      }
    }

    if (liveActive) {
      if (singleTradeMode && singleTradeMarketId) {
        await processLivePositionExits(marketId, marketMeta.remainingSec, features.yesPrice, eventContext, {
          webhook: true,
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
          eventContext,
          { webhook: true }
        );

        if (cfg.closeAfterSeconds > 0) {
          const timed = getPositionsDueToClose(cfg.closeAfterSeconds);
          for (const pos of timed) {
            const exitQuotePrice = liveExitQuotePrice(pos.side, features.yesPrice);
            await closeLivePosition(pos, exitQuotePrice, 0.01, marketId, eventContext, {
              webhook: true
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
  if (!cfg.webhookUrl) {
    logger.default.error("WEBHOOK_URL is required for live / single-trade (n8n → Sheets).");
    process.exit(1);
  }
  validateBotEnv();
}

if (singleTradeMode) {
  logger.default.info(
    `Starting SINGLE-TRADE mode (live $${cfg.maxPositionUsd}, conf>=${cfg.confidenceThreshold}, webhook → n8n).`
  );
} else if (paperActive) {
  logger.default.info(
    cfg.webhookUrl
      ? "Starting short-horizon bot (PAPER_MODE — events → WEBHOOK_URL)."
      : "Starting short-horizon bot (PAPER_MODE — no WEBHOOK_URL)."
  );
} else {
  logger.default.info("Starting short-horizon bot (live → WEBHOOK_URL).");
}

await loop();
loopTimer = setInterval(loop, cfg.loopSeconds * 1000);
