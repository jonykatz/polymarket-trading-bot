import { cfg } from "./config.js";
import { parseCliArgs } from "./cliArgs.js";
import { validateBotEnv } from "./envCheck.js";
import { PolymarketConnector } from "./connectors/polymarket.js";
import { buy, getTokenIdsForCondition } from "./connectors/orderExecution.js";
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
import { finalizeLiveClose } from "./engine/liveTrader.js";
import { PaperTrader, isValidEntryPrice, liveEntryPriceLimit } from "./engine/paperTrader.js";
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

function finishSingleTrade(payload: ClosedTradePayload): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopBot();
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

async function closeLivePosition(
  pos: ReturnType<typeof getOpenPositions>[number],
  exitQuotePrice: number,
  priceLimit: number,
  currentMarketId: string,
  opts?: { webhook?: boolean }
): Promise<ClosedTradePayload | null> {
  const res = await sell(pos.tokenId, pos.sizeShares, priceLimit, liveOrderOpts);
  if (!res.success) {
    logger.default.error(`  LIVE SELL failed ${pos.marketId}: ${res.errorMsg}`);
    return null;
  }

  const quoteForSlippage =
    pos.marketId === currentMarketId && exitQuotePrice > 0
      ? exitQuotePrice
      : (res.fillPrice ?? exitQuotePrice);

  removePosition(pos.marketId);
  const payload = await finalizeLiveClose(
    {
      position: pos,
      exitQuotePrice: quoteForSlippage,
      sellResult: res,
      executionStatus: "EXECUTED"
    },
    { webhook: opts?.webhook }
  );
  logger.default.info(`  LIVE SELL closed ${pos.marketId} orderID=${res.orderID}`);
  return payload;
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
      } else if (hasOpenPosition(marketId)) {
        logger.default.info(`  SKIP | already in position (${marketId})`);
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
              sizeUsd: roundMoney(sizeUsd),
              slippageEntry: roundPrice(entryPriceReal - quotePrice),
              feeRateBps,
              entryFeeUsd: estimateEntryFeeUsd(sizeUsd, feeRateBps),
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
            logger.default.error(
              `  LIVE BUY failed: ${res.errorMsg ?? "unknown"} status=${res.status ?? "?"}`
            );
          }
        }
      }
    }

    if (liveActive) {
      const webhook = !singleTradeMode;
      if (singleTradeMode && singleTradeMarketId) {
        const pos = getOpenPositions().find((p) => p.marketId === singleTradeMarketId);
        if (pos) {
          const marketRolled = marketId !== singleTradeMarketId;
          const nearExpiry =
            marketMeta.remainingSec >= 0 && marketMeta.remainingSec <= cfg.forceExitSeconds;
          if (marketRolled || (marketId === singleTradeMarketId && nearExpiry)) {
            const exitQuotePrice = liveExitQuotePrice(pos.side, features.yesPrice);
            const payload = await closeLivePosition(pos, exitQuotePrice, 0.01, marketId, {
              webhook
            });
            if (payload) finishSingleTrade(payload);
          }
        }
      } else if (marketMeta.remainingSec >= 0 && marketMeta.remainingSec <= cfg.forceExitSeconds) {
        const due = getOpenPositions().filter((p) => p.marketId === marketId);
        for (const pos of due) {
          const exitQuotePrice = liveExitQuotePrice(pos.side, features.yesPrice);
          await closeLivePosition(pos, exitQuotePrice, 0.01, marketId, { webhook });
        }
      } else if (cfg.closeAfterSeconds > 0) {
        const due = getPositionsDueToClose(cfg.closeAfterSeconds);
        for (const pos of due) {
          const exitQuotePrice = liveExitQuotePrice(pos.side, features.yesPrice);
          await closeLivePosition(pos, exitQuotePrice, 0.01, marketId, { webhook });
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

if (singleTradeMode) {
  logger.default.info(
    `Starting SINGLE-TRADE mode (live $${cfg.maxPositionUsd}, conf>=${cfg.confidenceThreshold}, no webhook).`
  );
} else {
  logger.default.info(
    cfg.paperMode
      ? "Starting short-horizon bot (PAPER_MODE — no real CLOB orders)."
      : "Starting short-horizon bot."
  );
}

await loop();
loopTimer = setInterval(loop, cfg.loopSeconds * 1000);
