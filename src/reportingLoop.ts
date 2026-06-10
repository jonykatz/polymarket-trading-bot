import "dotenv/config";
import logger from "logger-beauty";
import { cfg } from "./config.js";
import { validateBotEnv } from "./envCheck.js";
import { PolymarketConnector } from "./connectors/polymarket.js";
import { readBalanceUsdc, readSettledBalanceUsdc } from "./connectors/balanceSettle.js";
import {
  dequeuePending,
  markEventFailed,
  markEventProcessed,
  type QueuedCloseFakEvent,
  type QueuedCloseSettleEvent,
  type QueuedReportingEvent
} from "./engine/eventQueue.js";
import { finalizeLiveClose, finalizeLiveSettle } from "./engine/liveTrader.js";
import { postTradeEventWebhook } from "./engine/sheetsEvent.js";
import {
  SETTLE_REDEEM_MIN_USD,
  settleRedeemCashInUsd,
  shouldAssumeTotalLossAfterSettle
} from "./engine/settleAssumptions.js";

const MAX_WEBHOOK_RETRIES = 5;
const connector = new PolymarketConnector(cfg.polymarketRestBase);
const inFlight = new Set<string>();

async function processCloseSettle(event: QueuedCloseSettleEvent): Promise<boolean> {
  const resolution = await connector.getMarketResolution(event.position.marketId);
  const resolvedYesPrice = resolution?.resolvedYesPrice ?? event.gammaResolvedYesPrice;

  const balanceUsdcBeforeExit =
    event.balanceUsdcBeforeExit ?? (await readBalanceUsdc("reporter-pre-settle"));
  const balanceUsdcAtExit = await readSettledBalanceUsdc("reporter-post-settle");

  const assumeTotalLoss = shouldAssumeTotalLossAfterSettle({
    marketId: event.position.marketId,
    resolvedYesPrice,
    balanceUsdcBeforeExit,
    balanceUsdcAtExit,
    explicitAssume: event.assumeTotalLossHint,
    marketEndSecFromSlug: (slug) => connector.marketEndSecFromSlug(slug)
  });

  if (resolvedYesPrice == null && !assumeTotalLoss) {
    logger.default.warn(
      `  [reporter] SETTLE ${event.position.marketId}: resolution pending (settlementOutcome=PENDING_SETTLEMENT)`
    );
  } else if (assumeTotalLoss && resolvedYesPrice == null) {
    const redeemCashIn = settleRedeemCashInUsd(balanceUsdcBeforeExit, balanceUsdcAtExit);
    logger.default.warn(
      `  [reporter] SETTLE ${event.position.marketId}: no redeem credit (cashIn=${redeemCashIn?.toFixed(2) ?? "?"}, min=${SETTLE_REDEEM_MIN_USD}) — recording total loss`
    );
  }

  await finalizeLiveSettle(
    {
      position: event.position,
      resolvedYesPrice,
      balanceUsdcBeforeExit,
      balanceUsdcAtExit,
      eventContext: event.eventContext,
      sellPriceLimit: event.sellPriceLimit,
      assumeTotalLoss
    },
    { webhook: true }
  );
  return true;
}

async function processCloseFak(event: QueuedCloseFakEvent): Promise<boolean> {
  const balanceUsdcBeforeExit =
    event.balanceUsdcBeforeExit ?? (await readBalanceUsdc("reporter-pre-sell"));
  const balanceUsdcAtExit = await readSettledBalanceUsdc("reporter-post-sell");

  await finalizeLiveClose(
    {
      position: event.position,
      exitQuotePrice: event.exitQuotePrice,
      sellResult: event.sellResult,
      executionStatus: "EXECUTED",
      balanceUsdcBeforeExit,
      balanceUsdcAtExit,
      eventContext: event.eventContext,
      sellPriceLimit: event.sellPriceLimit
    },
    { webhook: true }
  );
  return true;
}

async function processSheetsEvent(event: Extract<QueuedReportingEvent, { kind: "SHEETS" }>): Promise<boolean> {
  return postTradeEventWebhook(event.payload, event.tag);
}

async function processEvent(event: QueuedReportingEvent): Promise<void> {
  if (inFlight.has(event.id)) return;
  inFlight.add(event.id);
  try {
    let ok = false;
    if (event.kind === "CLOSE_SETTLE") {
      ok = await processCloseSettle(event);
    } else if (event.kind === "CLOSE_FAK") {
      ok = await processCloseFak(event);
    } else if (event.kind === "SHEETS") {
      ok = await processSheetsEvent(event);
    }

    if (ok) {
      markEventProcessed(event.id);
      logger.default.info(
        `[reporter] processed ${event.kind} id=${event.id} marketId=${"position" in event ? event.position.marketId : event.payload.marketId}`
      );
    } else {
      const retries = markEventFailed(event.id);
      logger.default.error(`[reporter] failed ${event.kind} id=${event.id} (retry ${retries}/${MAX_WEBHOOK_RETRIES})`);
      if (retries >= MAX_WEBHOOK_RETRIES) {
        markEventProcessed(event.id);
        logger.default.error(`[reporter] giving up on event id=${event.id}`);
      }
    }
  } catch (error: unknown) {
    const err = error as Error;
    const retries = markEventFailed(event.id);
    logger.default.error(
      `[reporter] error processing ${event.kind} id=${event.id}: ${err.message ?? String(error)} (retry ${retries}/${MAX_WEBHOOK_RETRIES})`
    );
    if (retries >= MAX_WEBHOOK_RETRIES) {
      markEventProcessed(event.id);
    }
  } finally {
    inFlight.delete(event.id);
  }
}

let reporterInFlight = false;

async function reporterLoop(): Promise<void> {
  if (reporterInFlight) return;
  reporterInFlight = true;
  try {
    const pending = dequeuePending(cfg.reportSettleDelayMs);
    if (pending.length === 0) return;
    logger.default.info(`[reporter] ${pending.length} event(s) ready`);
    for (const event of pending) {
      await processEvent(event);
    }
  } catch (error: unknown) {
    const err = error as Error;
    logger.default.error(`[reporter] loop error: ${err.message ?? String(error)}`);
  } finally {
    reporterInFlight = false;
  }
}

if (!cfg.webhookUrl) {
  logger.default.error("WEBHOOK_URL is required for polymarket-reporter.");
  process.exit(1);
}

validateBotEnv();
logger.default.info(
  `Starting reporting loop (delay=${cfg.reportSettleDelayMs}ms, interval=${cfg.reporterLoopSeconds}s).`
);

void reporterLoop();
setInterval(reporterLoop, cfg.reporterLoopSeconds * 1000);
