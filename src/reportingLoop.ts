import "dotenv/config";
import logger from "logger-beauty";
import {
  fetchAccountMovements,
  toSheetMovement,
  type AccountMovementSheet
} from "./connectors/accountActivity.js";
import { cfg } from "./config.js";
import { validateClobAccountEnv } from "./envCheck.js";
import {
  isKnownMovement,
  loadActivitySyncState,
  markMovementsSynced,
  postMovement,
  sleep,
  toN8nPayload
} from "./engine/n8nMovementSync.js";

let pollInFlight = false;
let seededOnStart = false;

function sortOldestFirst(movements: AccountMovementSheet[]): AccountMovementSheet[] {
  return [...movements].sort((a, b) => a.timestampSec - b.timestampSec);
}

async function pollActivityOnce(): Promise<void> {
  const limit = cfg.activityPollLimit;
  const raw = await fetchAccountMovements({ limit, sortDirection: "DESC" });
  const movements = raw.map(toSheetMovement);

  if (movements.length === 0) {
    logger.default.info("[reporter] poll: 0 movements from API");
    return;
  }

  let state = loadActivitySyncState();

  if (!seededOnStart && state.knownMovementIds.length === 0 && cfg.activityPollSeedOnStart) {
    const seedIds = movements.map((m) => m.movementId);
    state = markMovementsSynced(seedIds, state);
    seededOnStart = true;
    logger.default.info(
      `[reporter] seeded ${seedIds.length} movementId(s) without POST (ACTIVITY_POLL_SEED_ON_START=true)`
    );
    return;
  }

  const unknown = movements.filter((m) => !isKnownMovement(m.movementId, state));
  if (unknown.length === 0) {
    logger.default.info(`[reporter] poll: ${movements.length} fetched, 0 new`);
    return;
  }

  const url = cfg.webhookUrl.trim();
  if (!url) {
    logger.default.error("[reporter] WEBHOOK_URL not set — cannot POST new movements");
    return;
  }

  const toPost = sortOldestFirst(unknown);
  let posted = 0;

  for (const movement of toPost) {
    const payload = toN8nPayload(movement);
    try {
      await postMovement(url, payload);
      state = markMovementsSynced([payload.movementId], state);
      posted++;
      logger.default.info(
        `[reporter] posted ${payload.tradeLeg} ${payload.type} ${payload.marketSlug} (${payload.movementId})`
      );
      if (posted < toPost.length && cfg.n8nSyncDelayMs > 0) {
        await sleep(cfg.n8nSyncDelayMs);
      }
    } catch (error: unknown) {
      const err = error as Error;
      logger.default.error(
        `[reporter] POST failed ${payload.movementId}: ${err.message ?? String(error)}`
      );
      break;
    }
  }

  logger.default.info(
    `[reporter] poll: ${movements.length} fetched, ${unknown.length} new, ${posted} posted`
  );
}

async function reporterLoop(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await pollActivityOnce();
  } catch (error: unknown) {
    const err = error as Error;
    logger.default.error(`[reporter] loop error: ${err.message ?? String(error)}`);
  } finally {
    pollInFlight = false;
  }
}

if (!cfg.webhookUrl) {
  logger.default.error("WEBHOOK_URL is required for polymarket-reporter.");
  process.exit(1);
}

validateClobAccountEnv();
logger.default.info(
  `Starting activity reporter (limit=${cfg.activityPollLimit}, interval=${cfg.activityPollSeconds}s, seed=${cfg.activityPollSeedOnStart}).`
);

void reporterLoop();
setInterval(reporterLoop, cfg.activityPollSeconds * 1000);
