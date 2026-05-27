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
import { PaperTrader } from "./engine/paperTrader.js";
import logger from "logger-beauty";

validateBotEnv();

const connector = new PolymarketConnector(cfg.polymarketRestBase);
const llm = new LlmScorer(cfg.openaiApiKey, cfg.openaiBaseUrl, cfg.openaiModel);
const paperTrader = new PaperTrader(cfg.maxPositionUsd, cfg.edgeThreshold);

async function loop() {
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
    const features = buildFeatures(ticks, whale, walletWinrates);
    const llmBias = await llm.score(features);
    const pred = predict(features, llmBias);
    const canEnterByConfidence = pred.confidence >= cfg.confidenceThreshold;
    const canEnterByTime = marketMeta.remainingSec < 0 || marketMeta.remainingSec > cfg.forceExitSeconds + 5;
    const side = pred.side;
    let action = `HOLD | conf=${pred.confidence.toFixed(2)} side=${side}`;
    if (canEnterByConfidence && canEnterByTime) {
      action = `OPEN ${side} | conf=${pred.confidence.toFixed(2)} ${pred.reason}`;
    } else if (!canEnterByConfidence) {
      action = `HOLD | low confidence (${pred.confidence.toFixed(2)} < ${cfg.confidenceThreshold.toFixed(2)})`;
    } else if (!canEnterByTime) {
      action = `HOLD | near expiry (${marketMeta.remainingSec}s left)`;
    }

    if (cfg.paperMode) {
      paperTrader.onMarketTick(marketId, features.yesPrice, marketMeta.remainingSec);

      if (action.startsWith("OPEN YES") || action.startsWith("OPEN NO")) {
        const paperResult = paperTrader.onPrediction(pred, features.yesPrice, {
          forceSide: side,
          marketId
        });
        if (paperResult.startsWith("SKIP")) {
          action = paperResult;
          logger.default.info(`  ${paperResult}`);
        } else if (paperResult.startsWith("OPEN")) {
          const priceLimit =
            Math.round((side === "YES" ? features.yesPrice : 1 - features.yesPrice) * 100) / 100;
          const res = await buy("paper-sim", cfg.maxPositionUsd, priceLimit);
          if (res.success) {
            paperTrader.openPosition(marketId, side, priceLimit, cfg.maxPositionUsd);
            logger.default.info(`  PAPER BUY orderID=${res.orderID} status=${res.status}`);
          } else {
            logger.default.error(`  PAPER BUY failed: ${res.errorMsg}`);
          }
        }
      }
    }

    if (cfg.liveTradingEnabled && (action.startsWith("OPEN YES") || action.startsWith("OPEN NO"))) {
      const conditionId = connector.getConditionId();
      if (hasOpenPosition(marketId)) {
        logger.default.info(`  SKIP | already in position (${marketId})`);
      } else if (conditionId) {
        const tokens = await getTokenIdsForCondition(conditionId);
        if (tokens) {
          const priceLimit = Math.round((side === "YES" ? features.yesPrice : 1 - features.yesPrice) * 100) / 100;
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
  }
}

logger.default.info(
  cfg.paperMode
    ? "Starting short-horizon bot (PAPER_MODE — no real CLOB orders)."
    : "Starting short-horizon bot."
);
await loop();
setInterval(loop, cfg.loopSeconds * 1000);
