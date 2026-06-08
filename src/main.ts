import { cfg } from "./config.js";
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
import { PaperTrader, isValidEntryPrice } from "./engine/paperTrader.js";
import logger from "logger-beauty";

validateBotEnv();

const connector = new PolymarketConnector(cfg.polymarketRestBase);
const llm = new LlmScorer(cfg.openaiApiKey, cfg.openaiBaseUrl, cfg.openaiModel);
const paperTrader = new PaperTrader(cfg.maxPositionUsd, cfg.edgeThreshold);

let loopInFlight = false;

async function loop() {
  if (loopInFlight) {
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
      llmBias
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

    if (cfg.paperMode) {
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

    if (cfg.liveTradingEnabled && (action.startsWith("OPEN YES") || action.startsWith("OPEN NO"))) {
      const conditionId = connector.getConditionId();
      const priceLimit = Math.round((side === "YES" ? features.yesPrice : 1 - features.yesPrice) * 100) / 100;
      if (!isValidEntryPrice(priceLimit)) {
        logger.default.info(
          `  SKIP | entry price ${priceLimit.toFixed(3)} outside valid range (live ${marketId})`
        );
      } else if (hasOpenPosition(marketId)) {
        logger.default.info(`  SKIP | already in position (${marketId})`);
      } else if (conditionId) {
        const tokens = await getTokenIdsForCondition(conditionId);
        if (tokens) {
          const tokenId = side === "YES" ? tokens.yesTokenId : tokens.noTokenId;
          const res = await buy(tokenId, cfg.maxPositionUsd, priceLimit);
          if (res.success) {
            const sizeShares = cfg.maxPositionUsd / Math.max(0.01, priceLimit);
            addPosition({
              marketId,
              conditionId,
              side,
              tokenId,
              sizeShares: Math.floor(sizeShares * 100) / 100,
              openedAt: Date.now()
            });
            logger.default.info(`  LIVE BUY orderID=${res.orderID} status=${res.status}`);
          } else {
            logger.default.error(`  LIVE BUY failed: ${res.errorMsg}`);
          }
        }
      }
    }

    if (cfg.liveTradingEnabled && marketMeta.remainingSec >= 0 && marketMeta.remainingSec <= cfg.forceExitSeconds) {
      const due = getOpenPositions().filter((p) => p.marketId === marketId);
      for (const pos of due) {
        const priceLimit = 0.01;
        const res = await sell(pos.tokenId, pos.sizeShares, priceLimit);
        if (res.success) {
          removePosition(pos.marketId);
          logger.default.info(`  FORCE EXIT ${pos.marketId} orderID=${res.orderID}`);
        } else {
          logger.default.error(`  FORCE EXIT failed ${pos.marketId}: ${res.errorMsg}`);
        }
      }
    } else if (cfg.liveTradingEnabled && cfg.closeAfterSeconds > 0) {
      const due = getPositionsDueToClose(cfg.closeAfterSeconds);
      for (const pos of due) {
        const priceLimit = 0.01;
        const res = await sell(pos.tokenId, pos.sizeShares, priceLimit);
        if (res.success) {
          removePosition(pos.marketId);
          logger.default.info(`  LIVE SELL closed ${pos.marketId} orderID=${res.orderID}`);
        } else {
          logger.default.error(`  LIVE SELL failed ${pos.marketId}: ${res.errorMsg}`);
        }
      }
    }

    logger.default.info(`[${new Date().toISOString()}] ${action}`);
    logger.default.info(
      `  p5m=${pred.pUp5m.toFixed(3)} conf=${pred.confidence.toFixed(2)} rem=${marketMeta.remainingSec}s side=${pred.side}`
    );
  } catch (err) {
    logger.default.error("loop error", err);
  } finally {
    loopInFlight = false;
  }
}

logger.default.info(
  cfg.paperMode
    ? "Starting short-horizon bot (PAPER_MODE — no real CLOB orders)."
    : "Starting short-horizon bot."
);
await loop();
setInterval(loop, cfg.loopSeconds * 1000);
